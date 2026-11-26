package com.kanban.offline

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONObject

internal class KanbanVoiceDrafts(private val root: File) {
    companion object {
        private val lock = Any()
        private val token = Regex("[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")
        private const val MAX_DRAFTS = 20
        private const val MAX_BYTES = 100L * 1024 * 1024
        private const val MAX_RECORDING = 50L * 1024 * 1024
    }

    data class Owner(val board: String, val task: String, val result: String) {
        companion object {
            fun from(data: JSONObject): Owner {
                val values = listOf(data.getString("board"), data.optString("task"), data.optString("result"))
                check(values[0].isNotEmpty() && values.all { it.length <= 200 && it.none(Char::isISOControl) })
                return Owner(values[0], values[1], values[2])
            }
        }
    }

    data class Draft(val file: File, val metadata: JSONObject) {
        val id: String get() = metadata.getString("draft")
    }

    fun list(): List<Draft> = synchronized(lock) {
        recoverInterrupted()
        root.list()?.mapNotNull(::read)?.sortedByDescending { it.metadata.getLong("createdAt") }.orEmpty()
    }

    fun open(id: String): Draft? = synchronized(lock) { read(id) }

    fun remove(id: String) = synchronized(lock) {
        if (!token.matches(id)) return@synchronized
        File(root, id).deleteRecursively()
    }

    fun hasRoom(): Boolean = synchronized(lock) {
        val drafts = list()
        drafts.size < MAX_DRAFTS && drafts.sumOf { it.file.length() } <= MAX_BYTES - MAX_RECORDING
    }

    fun publish(recording: File, owner: Owner, metadata: JSONObject): Draft = synchronized(lock) {
        check(root.isDirectory || root.mkdirs())
        val size = recording.length()
        val drafts = list()
        check(size in 1..MAX_RECORDING && drafts.size < MAX_DRAFTS && drafts.sumOf { it.file.length() } + size <= MAX_BYTES)
        val id = UUID.randomUUID().toString()
        val pending = File(root, ".part-$id")
        val published = File(root, id)
        check(pending.mkdir())
        try {
            val audio = File(pending, "audio.m4a")
            metadata.put("draft", id).put("size", size).put("createdAt", System.currentTimeMillis())
                .put("board", owner.board).put("task", owner.task).put("result", owner.result)
            FileOutputStream(File(pending, "draft.json")).use { out ->
                out.write(metadata.toString().toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            sync(pending)
            // Both directories are private app storage. Moving here avoids a second copy of the audio.
            FileOutputStream(recording, true).use { it.fd.sync() }
            Os.rename(recording.path, audio.path)
            sync(pending)
            Os.rename(pending.path, published.path)
            sync(root)
            Draft(File(published, "audio.m4a"), metadata)
        } finally { if (readDraft(pending, id) == null) pending.deleteRecursively() }
    }

    // A completed metadata file and matching size can be published on retry after a process interruption.
    fun recoverInterrupted() = synchronized(lock) {
        val directories = root.list().orEmpty()
        for (name in directories) {
            val id = name.removePrefix(".part-")
            if (id == name || !token.matches(id)) continue
            val pending = File(root, name)
            val published = File(root, id)
            if (!published.exists() && readDraft(pending, id) != null) {
                try { Os.rename(pending.path, published.path); sync(root) } catch (_: Exception) {}
            }
            if (published.isDirectory || readDraft(pending, id) == null) pending.deleteRecursively()
        }
    }

    private fun read(id: String): Draft? =
        if (token.matches(id)) readDraft(File(root, id), id) else null

    private fun readDraft(directory: File, id: String): Draft? = runCatching {
        val stateFile = File(directory, "draft.json")
        check(stateFile.length() in 1L..4096L)
        val metadata = JSONObject(stateFile.readText())
        Owner.from(metadata)
        check(metadata.getLong("createdAt") > 0 && metadata.getLong("ms") >= 0)
        val audio = File(directory, "audio.m4a")
        check(metadata.getString("draft") == id && audio.length() in 1..MAX_RECORDING &&
            audio.length() == metadata.getLong("size"))
        Draft(audio, metadata)
    }.getOrNull()

    private fun sync(directory: File) {
        val fd = Os.open(directory.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(fd) } finally { Os.close(fd) }
    }
}
