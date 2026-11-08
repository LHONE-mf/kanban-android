package com.kanban.offline

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

/**
 * Receives a saved Kanban attachment in acknowledged 32 KiB chunks, then uses
 * FileProvider + ACTION_VIEW to open it in an installed Android application.
 * Never downloads into public storage or mutates the source IndexedDB record.
 * All methods are called on the activity's main thread.
 */
internal class KanbanAttachmentOpener(
    private val activity: ComponentActivity,
    private val sendEvent: (JSONObject) -> Unit
) {
    private data class Transfer(
        val id: String,
        val file: File,
        val mime: String,
        val expected: Long,
        val stream: FileOutputStream,
        var written: Long = 0,
        var nextChunk: Int = 0
    )

    private val directory = File(activity.cacheDir, "attachment-open").apply { mkdirs() }
    private var active: Transfer? = null
    private var closed = false

    init {
        // External viewers need the file to remain readable after ACTION_VIEW.
        // Remove only older cached copies, never the file just handed to a viewer.
        val expired = System.currentTimeMillis() - 24L * 60L * 60L * 1000L
        directory.listFiles()?.filter { it.lastModified() < expired }?.forEach { it.delete() }
    }

    fun handle(raw: String) {
        if (closed || raw.length > 48_000) return
        val request = try { JSONObject(raw) } catch (_: Exception) { return }
        val id = request.optString("id")
        if (!id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) return
        when (request.optString("type")) {
            "start" -> start(request, id)
            "chunk" -> append(request, id)
            "finish" -> finish(id)
            "abort" -> if (active?.id == id) {
                discard()
                reply(id, "cancelled")
            }
        }
    }

    private fun start(request: JSONObject, id: String) {
        if (active != null) {
            reply(id, "error", "Сначала завершите открытие другого файла")
            return
        }
        val name = request.optString("name")
        val safe = name.substringAfterLast('/').substringAfterLast('\\')
            .filter { it.isLetterOrDigit() || it in " ._-()" }.trim().take(120)
            .let { if (it.isBlank() || it == "." || it == "..") "attachment.bin" else it }
        val expected = request.optLong("size", -1)
        if (name.isBlank() || name.length > 250 || expected <= 0 ||
            expected > 50L * 1024L * 1024L) {
            reply(id, "error", "Некорректный размер или имя вложения")
            return
        }
        val extension = safe.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
        val declared = request.optString("mime")
        val mime = if (declared.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) &&
            declared != "application/octet-stream") declared else detected ?: "application/octet-stream"
        try {
            val file = File.createTempFile("open-", "-$safe", directory)
            try {
                active = Transfer(id, file, mime, expected, FileOutputStream(file))
            } catch (e: Exception) {
                file.delete()
                throw e
            }
            reply(id, "ready")
        } catch (_: Exception) {
            reply(id, "error", "Не удалось подготовить вложение")
        }
    }

    private fun append(request: JSONObject, id: String) {
        val transfer = active ?: return
        if (transfer.id != id) return
        try {
            if (request.optInt("index", -1) != transfer.nextChunk) {
                throw IllegalArgumentException("Нарушен порядок фрагментов")
            }
            val encoded = request.getString("data")
            if (encoded.isEmpty() || encoded.length > 43_696) {
                throw IllegalArgumentException("Недопустимый фрагмент")
            }
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            if (bytes.isEmpty() || bytes.size > 32 * 1024 ||
                transfer.written + bytes.size > transfer.expected) {
                throw IllegalArgumentException("Недопустимый размер")
            }
            transfer.stream.write(bytes)
            transfer.written += bytes.size
            transfer.nextChunk++
            reply(id, "ack", index = transfer.nextChunk)
        } catch (_: Exception) {
            discard()
            reply(id, "error", "Не удалось прочитать вложение")
        }
    }

    private fun finish(id: String) {
        val transfer = active ?: return
        if (transfer.id != id) return
        if (transfer.written != transfer.expected) {
            discard()
            reply(id, "error", "Файл передан не полностью")
            return
        }
        try {
            transfer.stream.close()
            val uri: Uri = FileProvider.getUriForFile(
                activity, "${activity.packageName}.editablefiles", transfer.file
            )
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, transfer.mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newUri(activity.contentResolver, transfer.file.name, uri)
            }
            activity.startActivity(Intent.createChooser(view, "Открыть файл"))
            // A headless emulator may lack a compatible document viewer. Record
            // that ACTION_VIEW was dispatched, without logging names or bytes.
            Log.i("KanbanAttachmentOpen", "ACTION_VIEW chooser dispatched")
            active = null
            reply(id, "opened")
        } catch (_: Exception) {
            discard()
            reply(id, "error", "Нет приложения для открытия файла или доступ запрещён")
        }
    }

    fun close() {
        closed = true
        discard()
    }

    private fun discard() {
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
