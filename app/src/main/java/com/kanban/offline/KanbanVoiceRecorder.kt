package com.kanban.offline

import android.content.Context
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One foreground capture, one private temporary file. Recorder calls are serialized off the UI thread. */
internal class KanbanVoiceRecorder(
    private val context: Context,
    private val emit: (JSONObject) -> Unit
) {
    private val directory = File(context.cacheDir, "voice-capture").apply { mkdirs() }
    private val thread = HandlerThread("ComradeVoice").apply { start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var id: String? = null
    private var file: File? = null
    private var elapsed = 0L
    private var started = 0L
    private var paused = false
    @Volatile private var closed = false
    private data class Ready(val id: String, val token: String, val file: File)
    @Volatile private var ready: Ready? = null

    private fun send(session: String, type: String, fields: JSONObject = JSONObject()) {
        fields.put("id", session).put("type", type)
        main.post { if (!closed) emit(fields) }
    }
    private fun duration() = elapsed + if (paused) 0L else SystemClock.elapsedRealtime() - started
    private val tick = object : Runnable {
        override fun run() {
            val current = recorder ?: return
            val session = id ?: return
            val ms = duration()
            if (ms >= 1_200_000L) { finish(session); return }
            val amplitude = if (paused) 0 else runCatching { current.maxAmplitude }.getOrDefault(0)
            send(session, "level", JSONObject().put("ms", ms).put("level", amplitude / 32768.0))
            worker.postDelayed(this, 200)
        }
    }
    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()

    fun start(session: String) = enqueue {
        if (id != null || ready != null) {
            send(session, "error", JSONObject().put("message", "Предыдущая запись ещё не завершена"))
            return@enqueue
        }
        id = session
        try {
            // Raw source where supported; VOICE_RECOGNITION avoids communication processing.
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val raw = audio.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
            val source = if (raw) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
            val target = File.createTempFile("capture-", ".m4a", directory)
            file = target
            val capture = newRecorder()
            recorder = capture
            capture.setAudioSource(source)
            capture.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            capture.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            capture.setAudioChannels(1)
            capture.setAudioSamplingRate(48000)
            capture.setAudioEncodingBitRate(128000)
            capture.setOutputFile(target.absolutePath)
            capture.setOnErrorListener { _, _, _ -> worker.post {
                if (recorder === capture) fail(session, "Ошибка записи Android")
            } }
            capture.prepare()
            capture.start()
            elapsed = 0L
            started = SystemClock.elapsedRealtime()
            paused = false
            send(session, "started")
            worker.post(tick)
        } catch (e: Exception) { fail(session, "Не удалось начать запись: " + (e.message ?: e.javaClass.simpleName)) }
    }

    fun command(session: String, action: String) = enqueue {
        if (action == "ack") {
            ready?.takeIf { it.id == session }?.let { ready = null; it.file.delete() }
            return@enqueue
        }
        if (action == "cancel") {
            if (id == session) reset(true)
            ready?.takeIf { it.id == session }?.let { ready = null; it.file.delete() }
            send(session, "cancelled")
            return@enqueue
        }
        if (id != session) return@enqueue
        try {
            when (action) {
                "pause" -> if (!paused) {
                    recorder?.pause()
                    elapsed = duration()
                    paused = true
                    send(session, "paused", JSONObject().put("ms", elapsed))
                }
                "resume" -> if (paused) {
                    recorder?.resume()
                    started = SystemClock.elapsedRealtime()
                    paused = false
                    send(session, "resumed", JSONObject().put("ms", elapsed))
                }
                "stop" -> finish(session)
            }
        } catch (e: Exception) { fail(session, "Ошибка записи: " + (e.message ?: e.javaClass.simpleName)) }
    }

    private fun finish(session: String) {
        if (id != session) return
        val target = file ?: return
        val ms = duration()
        try {
            recorder?.stop()
            reset(false)
            if (target.length() !in 1L..(50L * 1024 * 1024)) throw IllegalStateException("Пустая или слишком большая запись")
            val result = Ready(session, UUID.randomUUID().toString(), target)
            ready = result
            send(session, "ready", JSONObject().put("token", result.token).put("ms", ms).put("size", target.length()))
        } catch (e: Exception) {
            target.delete()
            fail(session, "Не удалось сохранить запись: " + (e.message ?: e.javaClass.simpleName))
        }
    }
    private fun fail(session: String, message: String) {
        reset(true)
        send(session, "error", JSONObject().put("message", message))
    }
    private fun reset(delete: Boolean) {
        worker.removeCallbacks(tick)
        runCatching { recorder?.release() }
        recorder = null
        if (delete) file?.delete()
        file = null
        id = null
        paused = false
    }
    // Only the exact, unpredictable token for the finished file is served.
    fun resource(path: String): WebResourceResponse {
        val current = ready
        if (closed || current == null || path != current.token) return WebResourceResponse(null, null, null)
        return try {
            WebResourceResponse("audio/mp4", null, 200, "OK",
                mapOf("Cache-Control" to "no-store", "Content-Length" to current.file.length().toString()),
                current.file.inputStream())
        } catch (_: Exception) { WebResourceResponse(null, null, null) }
    }
    fun stopInBackground() = enqueue { id?.let { finish(it) } }
    private fun enqueue(block: () -> Unit) {
        if (!closed) worker.post { if (!closed) block() }
    }
    fun close() {
        closed = true
        worker.post {
            reset(true)
            ready?.file?.delete()
            ready = null
            thread.quitSafely()
        }
    }
}
