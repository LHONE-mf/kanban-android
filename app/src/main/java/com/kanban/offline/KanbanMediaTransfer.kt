package com.kanban.offline

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger

/** Bounded staging for operations whose source still lives in WebView's IndexedDB. */
internal class KanbanMediaTransfer(context: Context, private val emit: (JSONObject) -> Unit) {
    companion object {
        const val MAX_CHUNK_BYTES = 256 * 1024
        const val ID_BYTES = 36
        private const val MAX_FILE_BYTES = 50L * 1024 * 1024
        private val sessionId = Regex("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
    }

    private val cache = File(context.cacheDir, "native-media")
    private val thread = HandlerThread("ComradeMedia").apply { start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private val queued = AtomicInteger()
    @Volatile private var closed = false
    @Volatile private var foreground = false

    private data class Upload(
        val id: String, val size: Long, val operation: String, val file: File, val output: FileOutputStream,
        var written: Long = 0
    )

    private data class PhotoLease(val id: String, val photo: KanbanPhotoProcessor.Photo)
    @Volatile private var photoLease: PhotoLease? = null
    private val photoTimeout = Runnable { clearPhoto() }

    private var upload: Upload? = null
    private val uploadTimeout = Runnable {
        upload?.let {
            abortUpload()
            send(it.id, "error", "Передача файла прервана")
        }
    }
    private val audio = KanbanAudioPlayer(context, worker, ::send)

    private fun send(id: String, type: String, message: String? = null, state: JSONObject? = null) {
        val payload = state ?: JSONObject()
        payload.put("id", id).put("type", type)
        if (message != null) payload.put("message", message)
        main.post { if (!closed) emit(payload) }
    }

    fun command(raw: String) = dispatch {
        val data = runCatching { JSONObject(raw) }.getOrNull() ?: return@dispatch
        val id = data.optString("id")
        if (!sessionId.matches(id)) return@dispatch
        try {
            when (val type = data.optString("type")) {
                "begin" -> begin(id, data.optLong("size"), data.optString("operation", "audio"))
                "finish" -> finish(id)
                "discard" -> {
                    if (upload?.id == id) abortUpload()
                    if (photoLease?.id == id) clearPhoto()
                    audio.command(id, "stop", data)
                }
                "play" -> {
                    if (foreground) audio.command(id, type, data)
                    else send(id, "unavailable", "Откройте Comrade для воспроизведения")
                }
                "pause", "seek", "rate", "stop" -> audio.command(id, type, data)
            }
        } catch (_: Exception) {
            if (upload?.id == id) abortUpload()
            send(id, "error", "Не удалось обработать файл на Android")
        }
    }

    fun chunk(bytes: ByteArray) = dispatch {
        val id = String(bytes, 0, ID_BYTES, Charsets.US_ASCII)
        val current = upload?.takeIf { it.id == id } ?: return@dispatch
        val length = bytes.size - ID_BYTES
        try {
            check(length in 1..MAX_CHUNK_BYTES && current.written + length <= current.size)
            current.output.write(bytes, ID_BYTES, length)
            current.written += length
            refreshTimeout()
            send(id, "chunk")
        } catch (_: Exception) {
            abortUpload()
            send(id, "error", "Не удалось записать часть файла")
        }
    }

    private fun begin(id: String, size: Long, operation: String) {
        check(size in 1..MAX_FILE_BYTES && upload == null && operation in setOf("audio", "photo"))
        check(cache.isDirectory || cache.mkdirs())
        val file = File.createTempFile("media-", ".tmp", cache)
        try {
            upload = Upload(id, size, operation, file, FileOutputStream(file))
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        refreshTimeout()
        send(id, "begin")
    }

    private fun finish(id: String) {
        val current = upload?.takeIf { it.id == id } ?: error("Missing upload")
        check(current.written == current.size)
        current.output.close()
        upload = null
        worker.removeCallbacks(uploadTimeout)
        if (current.operation == "audio") {
            audio.load(id, current.file)
            return
        }
        try {
            val photo = KanbanPhotoProcessor.process(current.file, cache)
            clearPhoto()
            photoLease = PhotoLease(id, photo)
            worker.postDelayed(photoTimeout, 30_000L)
            send(id, "loaded", state = JSONObject().put("originalMime", photo.originalMime)
                .put("mime", photo.mime).put("fullSize", photo.full?.length() ?: 0L).put("thumbSize", photo.thumb.length()))
        } finally { current.file.delete() }
    }

    private fun clearPhoto() {
        worker.removeCallbacks(photoTimeout)
        val current = photoLease
        photoLease = null
        current?.photo?.delete()
    }

    fun resource(path: String): WebResourceResponse {
        val current = photoLease
        if (closed || current == null) return WebResourceResponse(null, null, null)
        val file = when (path) {
            "${current.id}/full" -> current.photo.full
            "${current.id}/thumb" -> current.photo.thumb
            else -> null
        } ?: return WebResourceResponse(null, null, null)
        return try {
            WebResourceResponse(current.photo.mime, null, 200, "OK",
                mapOf("Cache-Control" to "no-store", "Content-Length" to file.length().toString()), file.inputStream())
        } catch (_: Exception) { WebResourceResponse(null, null, null) }
    }

    private fun refreshTimeout() {
        worker.removeCallbacks(uploadTimeout)
        worker.postDelayed(uploadTimeout, 30_000L)
    }

    private fun abortUpload() {
        worker.removeCallbacks(uploadTimeout)
        upload?.let {
            runCatching { it.output.close() }
            it.file.delete()
        }
        upload = null
    }

    private fun dispatch(block: () -> Unit) {
        if (closed) return
        if (queued.incrementAndGet() > 8) {
            queued.decrementAndGet()
            return
        }
        if (!worker.post {
            try { if (!closed) block() } finally { queued.decrementAndGet() }
        }) queued.decrementAndGet()
    }

    fun reset() {
        worker.post {
            abortUpload()
            clearPhoto()
            audio.reset()
        }
    }

    fun setForeground(visible: Boolean) {
        foreground = visible
        if (!visible) worker.post { audio.pause() }
    }

    fun close() {
        closed = true
        worker.post {
            abortUpload()
            clearPhoto()
            audio.close()
            thread.quitSafely()
        }
    }
}
