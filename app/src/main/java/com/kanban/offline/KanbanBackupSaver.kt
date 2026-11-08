package com.kanban.offline

import android.net.Uri
import android.util.Base64
import androidx.activity.ComponentActivity
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Streams a JSON backup from the trusted WebView into a private temporary file, then
 * lets Android's document picker choose the destination. A success event is sent only
 * after the selected document has been fully written and closed.
 *
 * All public methods are called on the activity's main thread. Large document copying
 * happens off the UI thread; only bounded 32 KiB chunks cross the WebView bridge.
 */
internal class KanbanBackupSaver(
    private val activity: ComponentActivity,
    private val chooseDestination: (String) -> Unit,
    private val sendEvent: (JSONObject) -> Unit
) {
    private data class Transfer(
        val id: String,
        val file: File,
        val name: String,
        val totalBytes: Long,
        val stream: FileOutputStream,
        var bytesWritten: Long = 0,
        var nextChunk: Int = 0,
        var awaitingPicker: Boolean = false,
        var saving: Boolean = false
    )

    private var active: Transfer? = null
    private var destroyed = false

    fun handle(raw: String) {
        if (destroyed || raw.length > 48_000) return
        val request = try { JSONObject(raw) } catch (_: Exception) { return }
        val type = request.optString("type")
        val id = request.optString("id")
        if (!id.matches(Regex("[a-zA-Z0-9_-]{1,64}"))) return

        when (type) {
            "start" -> start(request, id)
            "chunk" -> append(request, id)
            "finish" -> finish(id)
            "abort" -> {
                if (active?.id == id && active?.saving != true) {
                    clear()
                    reply(id, "cancelled")
                }
            }
        }
    }

    private fun start(request: JSONObject, id: String) {
        if (active != null) {
            reply(id, "error", "Сначала завершите текущее сохранение")
            return
        }
        val name = request.optString("name")
        val bytes = request.optLong("size", -1)
        if (!name.matches(Regex("kanban-backup-\\d{4}-\\d{2}-\\d{2}\\.json")) ||
            bytes <= 0 || bytes > 2_000_000_000L) {
            reply(id, "error", "Некорректные параметры бэкапа")
            return
        }
        try {
            val file = File.createTempFile("kanban-backup-", ".tmp", activity.cacheDir)
            try {
                active = Transfer(id, file, name, bytes, FileOutputStream(file))
            } catch (e: Exception) {
                file.delete()
                throw e
            }
            reply(id, "ready")
        } catch (_: Exception) {
            reply(id, "error", "Не удалось подготовить временный файл бэкапа")
        }
    }

    private fun append(request: JSONObject, id: String) {
        val transfer = active ?: return
        if (transfer.id != id || transfer.awaitingPicker || transfer.saving) return
        try {
            if (request.optInt("index", -1) != transfer.nextChunk) {
                throw IllegalArgumentException("Нарушен порядок передачи данных")
            }
            val encoded = request.getString("data")
            if (encoded.isEmpty() || encoded.length > 43_696) {
                throw IllegalArgumentException("Недопустимый размер фрагмента")
            }
            val chunk = Base64.decode(encoded, Base64.NO_WRAP)
            if (chunk.isEmpty() || chunk.size > 32 * 1024 ||
                transfer.bytesWritten + chunk.size > transfer.totalBytes) {
                throw IllegalArgumentException("Ошибка размера фрагмента")
            }
            transfer.stream.write(chunk)
            transfer.bytesWritten += chunk.size
            transfer.nextChunk++
            reply(id, "ack", index = transfer.nextChunk)
        } catch (_: Exception) {
            clear()
            reply(id, "error", "Ошибка записи промежуточного файла бэкапа")
        }
    }

    private fun finish(id: String) {
        val transfer = active ?: return
        if (transfer.id != id || transfer.awaitingPicker || transfer.saving) return
        if (transfer.bytesWritten != transfer.totalBytes) {
            clear()
            reply(id, "error", "Бэкап передан не полностью")
            return
        }
        try {
            transfer.stream.fd.sync()
            transfer.stream.close()
            transfer.awaitingPicker = true
            chooseDestination(transfer.name)
            reply(id, "choosing")
        } catch (_: Exception) {
            clear()
            reply(id, "error", "Не удалось открыть окно выбора папки")
        }
    }

    fun onDestinationPicked(uri: Uri?) {
        val transfer = active ?: return
        if (!transfer.awaitingPicker || transfer.saving) return
        if (uri == null) {
            clear()
            reply(transfer.id, "cancelled")
            return
        }
        transfer.saving = true
        Thread {
            var failure: String? = null
            try {
                val output = activity.contentResolver.openOutputStream(uri, "w")
                    ?: throw IllegalStateException("Не удалось открыть выбранный файл")
                var copied = 0L
                output.use { destination ->
                    FileInputStream(transfer.file).use { source ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = source.read(buffer)
                            if (read == -1) break
                            destination.write(buffer, 0, read)
                            copied += read
                        }
                    }
                    destination.flush()
                }
                if (copied != transfer.totalBytes) {
                    throw IllegalStateException("Файл сохранён не полностью")
                }
            } catch (_: Exception) {
                failure = "Не удалось записать бэкап в выбранную папку"
                // The document was newly created by ACTION_CREATE_DOCUMENT. Remove any
                // partial copy rather than leaving an apparently valid backup behind.
                try { activity.contentResolver.delete(uri, null, null) } catch (_: Exception) {}
            } finally {
                transfer.file.delete()
            }
            activity.runOnUiThread {
                if (active === transfer) active = null
                if (!destroyed) {
                    if (failure == null) reply(transfer.id, "saved")
                    else reply(transfer.id, "error", failure)
                }
            }
        }.start()
    }

    fun close() {
        destroyed = true
        if (active?.saving != true) clear()
    }

    private fun clear() {
        val transfer = active ?: return
        active = null
        try { transfer.stream.close() } catch (_: Exception) {}
        transfer.file.delete()
    }

    private fun reply(id: String, type: String, message: String? = null, index: Int? = null) {
        val event = JSONObject().put("id", id).put("type", type)
        if (message != null) event.put("message", message)
        if (index != null) event.put("index", index)
        sendEvent(event)
    }
}
