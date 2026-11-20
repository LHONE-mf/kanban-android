package com.kanban.offline

import android.util.Base64
import androidx.activity.ComponentActivity
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Receives bounded 32 KiB chunks from the trusted offline WebView and opens a
 * private cache copy via a read-only FileProvider URI. Never exposes IndexedDB.
 */
internal class KanbanAttachmentOpener(
    private val activity: ComponentActivity,
    private val launchViewer: (File, String, String) -> Unit,
    private val sendEvent: (JSONObject) -> Unit
) {
    private data class Transfer(
        val id: String, val file: File, val bytes: Long, val name: String,
        val mime: String, val output: FileOutputStream,
        var written: Long = 0L, var index: Int = 0
    )
    private var active: Transfer? = null
    private var closed = false

    fun handle(raw: String) {
        if (closed || raw.length > 48_000) return
        val request = try { JSONObject(raw) } catch (_: Exception) { return }
        val id = request.optString("id")
        if (!id.matches(Regex("[a-zA-Z0-9_-]{1,64}"))) return
        when (request.optString("type")) {
            "start" -> start(request, id)
            "chunk" -> append(request, id)
            "finish" -> finish(id)
            "abort" -> if (active?.id == id) { discard(); reply(id, "cancelled") }
        }
    }

    private fun start(request: JSONObject, id: String) {
        if (active != null) { reply(id, "error", "Предыдущий файл ещё открывается"); return }
        val size = request.optLong("size", -1)
        val name = request.optString("name")
        val mime = request.optString("mime")
        if (size < 0 || size > 50L * 1024 * 1024 || name.length !in 1..200 ||
            !mime.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+"))) {
            reply(id, "error", "Некорректные параметры вложения")
            return
        }
        val safeName = name.filter { it.isLetterOrDigit() || it in " ._-()" }.take(120)
            .ifBlank { "file" }
        try {
            val dir = File(activity.cacheDir, "viewed").apply { mkdirs() }
            val file = File(dir, "$id-$safeName")
            try {
                active = Transfer(id, file, size, name, mime, FileOutputStream(file))
                reply(id, "ready")
            } catch (error: Exception) {
                file.delete()
                throw error
            }
        } catch (_: Exception) { reply(id, "error", "Не удалось подготовить файл") }
    }

    private fun append(request: JSONObject, id: String) {
        val transfer = active ?: return
        if (transfer.id != id) return
        try {
            if (request.optInt("index", -1) != transfer.index)
                throw IllegalArgumentException("Неверный порядок фрагментов")
            val encoded = request.getString("data")
            if (encoded.isEmpty() || encoded.length > 43_696)
                throw IllegalArgumentException("Недопустимый фрагмент")
            val chunk = Base64.decode(encoded, Base64.NO_WRAP)
            if (chunk.isEmpty() || chunk.size > 32 * 1024 ||
                transfer.written + chunk.size > transfer.bytes)
                throw IllegalArgumentException("Недопустимый размер вложения")
            transfer.output.write(chunk)
            transfer.written += chunk.size
            transfer.index++
            reply(id, "ack", index = transfer.index)
        } catch (_: Exception) {
            discard()
            reply(id, "error", "Не удалось передать вложение")
        }
    }

    private fun finish(id: String) {
        val transfer = active ?: return
        if (transfer.id != id) return
        if (transfer.written != transfer.bytes) {
            discard()
            reply(id, "error", "Файл передан не полностью")
            return
        }
        try {
            transfer.output.fd.sync()
            transfer.output.close()
            active = null
            try {
                launchViewer(transfer.file, transfer.mime, transfer.name)
                // Keep a cache copy until Android can read it through FileProvider.
                reply(id, "opened")
            } catch (_: Exception) {
                transfer.file.delete()
                reply(id, "error", "Не найдено приложение для открытия файла")
            }
        } catch (_: Exception) {
            discard()
            reply(id, "error", "Не удалось завершить передачу файла")
        }
    }

    fun close() { closed = true; discard() }

    private fun discard() {
        val transfer = active ?: return
        active = null
        try { transfer.output.close() } catch (_: Exception) {}
        transfer.file.delete()
    }

    private fun reply(id: String, type: String, message: String? = null, index: Int? = null) {
        val response = JSONObject().put("id", id).put("type", type)
        if (message != null) response.put("message", message)
        if (index != null) response.put("index", index)
        sendEvent(response)
    }
}
