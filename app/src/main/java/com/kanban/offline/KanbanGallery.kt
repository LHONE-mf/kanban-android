package com.kanban.offline

import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.view.Gravity
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.UUID
import org.json.JSONObject

internal class KanbanGallery(private val context: Context, private val emit: (JSONObject) -> Unit) {
    private val main = Handler(context.mainLooper)
    private var dialog: Dialog? = null
    private var id: String? = null
    @Volatile private var requested: String? = null
    private var count = 0
    private var index = 0
    private lateinit var contents: FrameLayout
    private lateinit var position: TextView
    private lateinit var previous: Button
    private lateinit var next: Button
    private var video: VideoView? = null
    private var controller: MediaController? = null
    private var videoFile: File? = null
    private var foreground = true

    fun accepts(requestId: String) = requested == requestId

    fun open(session: String, size: Int, selected: Int, title: String) {
        close()
        id = session
        count = size
        val popup = Dialog(context, android.R.style.Theme_Material_NoActionBar)
        dialog = popup
        popup.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        ViewCompat.setOnApplyWindowInsetsListener(layout) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(context).apply {
            text = title
            maxLines = 2
            setTextColor(Color.WHITE)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("Файл", "Открыть сохранённый файл в другом приложении") {
            emit(JSONObject().put("id", session).put("type", "external").put("index", index))
        })
        header.addView(button("✕", "Закрыть галерею") { popup.dismiss() })
        contents = FrameLayout(context)
        layout.addView(header)
        layout.addView(contents, LinearLayout.LayoutParams(-1, 0, 1f))
        val navigation = LinearLayout(context).apply { gravity = Gravity.CENTER }
        previous = button("‹", "Предыдущее вложение") { request(index - 1) }
        next = button("›", "Следующее вложение") { request(index + 1) }
        position = TextView(context).apply { setTextColor(Color.WHITE) }
        navigation.addView(previous)
        navigation.addView(position)
        navigation.addView(next)
        layout.addView(navigation)
        popup.setContentView(layout)
        popup.setOnDismissListener {
            if (popup === dialog) {
                dialog = null
                requested = null
                id = null
                clearContents()
                emit(JSONObject().put("id", session).put("type", "closed"))
            }
        }
        popup.show()
        popup.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        ViewCompat.requestApplyInsets(layout)
        request(selected)
    }

    private fun button(text: String, label: String, action: () -> Unit) = Button(context).apply {
        this.text = text
        contentDescription = label
        setOnClickListener { action() }
    }

    private fun request(item: Int) {
        if (item !in 0 until count) return
        val session = id ?: return
        clearContents()
        index = item
        previous.isEnabled = index > 0
        next.isEnabled = index < count - 1
        position.text = "${index + 1} / $count"
        contents.addView(TextView(context).apply {
            gravity = Gravity.CENTER
            text = "Загрузка…"
            setTextColor(Color.WHITE)
        }, FrameLayout.LayoutParams(-1, -1))
        val token = UUID.randomUUID().toString()
        requested = token
        emit(JSONObject().put("id", session).put("type", "request").put("request", token).put("index", index))
    }

    // Called on the media worker. Ownership of the temporary source ends here.
    fun decode(requestId: String, file: File, movie: Boolean) {
        if (!accepts(requestId)) { file.delete(); return }
        if (movie) {
            main.post {
                if (accepts(requestId)) showVideo(requestId, file) else file.delete()
            }
            return
        }
        val image = try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                check(w > 0 && h > 0 && w.toLong() * h <= 150_000_000)
                val scale = 2048.0 / maxOf(w, h)
                if (scale < 1) decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } finally { file.delete() }
        main.post {
            if (!accepts(requestId)) { image.recycle(); return@post }
            clearContents()
            contents.addView(ZoomPhoto(context, image) { request(index + it) }, FrameLayout.LayoutParams(-1, -1))
        }
    }

    private fun showVideo(requestId: String, file: File) {
        clearContents()
        videoFile = file
        val media = MediaController(context)
        controller = media
        val player = VideoView(context)
        video = player
        contents.addView(player, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        player.setMediaController(media)
        player.setOnPreparedListener {
            if (accepts(requestId) && foreground) player.start()
        }
        player.setOnErrorListener { _, _, _ ->
            if (accepts(requestId)) {
                val session = id
                emit(JSONObject().put("id", session).put("type", "fallback").put("index", index))
                close()
            }
            true
        }
        player.setVideoPath(file.absolutePath)
    }

    private fun clearContents() {
        controller?.hide()
        controller = null
        video?.stopPlayback()
        video = null
        videoFile?.delete()
        videoFile = null
        contents.removeAllViews()
    }

    fun setForeground(visible: Boolean) {
        foreground = visible
        if (!visible) video?.pause()
    }

    fun close(session: String? = null) {
        if (session != null && id != session) return
        requested = null
        dialog?.dismiss()
    }

    private class ZoomPhoto(context: Context, private val bitmap: Bitmap, page: (Int) -> Unit) : View(context) {
        private var zoom = 1f
        private var left = 0f
        private var top = 0f
        private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val rect = RectF()
        private val base get() = minOf(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
        private val scaledWidth get() = bitmap.width * base * zoom
        private val scaledHeight get() = bitmap.height * base * zoom
        private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val newZoom = (zoom * detector.scaleFactor).coerceIn(1f, 5f)
                val ratio = newZoom / zoom
                left = detector.focusX - (detector.focusX - left) * ratio
                top = detector.focusY - (detector.focusY - top) * ratio
                zoom = newZoom
                fit()
                return true
            }
        })
        private var pinched = false
        private val tapDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onScroll(first: MotionEvent?, current: MotionEvent, dx: Float, dy: Float): Boolean {
                if (zoom > 1f && !scaleDetector.isInProgress) {
                    left -= dx
                    top -= dy
                    fit()
                }
                return true
            }
            override fun onFling(first: MotionEvent?, last: MotionEvent, vx: Float, vy: Float): Boolean {
                if (first == null || zoom > 1f || pinched) return false
                val dx = last.x - first.x
                if (kotlin.math.abs(dx) < 48 * resources.displayMetrics.density ||
                    kotlin.math.abs(dx) < kotlin.math.abs(last.y - first.y)) return false
                page(if (dx < 0) 1 else -1)
                return true
            }
        })
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { fit() }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) pinched = false
            if (event.pointerCount > 1) pinched = true
            scaleDetector.onTouchEvent(event)
            tapDetector.onTouchEvent(event)
            return true
        }

        private fun fit() {
            fun clamp(offset: Float, outer: Int, inner: Float) =
                if (inner <= outer) (outer - inner) / 2 else offset.coerceIn(outer - inner, 0f)
            left = clamp(left, width, scaledWidth)
            top = clamp(top, height, scaledHeight)
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            if (bitmap.isRecycled) return
            rect.set(left, top, left + scaledWidth, top + scaledHeight)
            canvas.drawBitmap(bitmap, null, rect, paint)
        }
    }
}
