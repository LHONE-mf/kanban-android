package com.kanban.offline

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FilterInputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.json.JSONArray
import org.json.JSONObject

/** The transfer worker owns the archive. Only verified entries are served back to the page. */
internal class KanbanZipBackup(
    private val context: Context,
    private val worker: Handler,
    private val choose: (String) -> Unit,
    private val emit: (String, String, String?, JSONObject?) -> Unit
) {
    private companion object {
        const val FORMAT = "comrade-backup"
        const val STATE = "state.json"
        const val MANIFEST = "manifest.json"
        const val MAX_ENTRIES = 12_000
        const val MAX_TOTAL = 2_000_000_000L
        const val MAX_METADATA = 32L * 1024 * 1024
        const val MAX_FILE = 50L * 1024 * 1024
        val mediaName = Regex("media/[0-9]{6}\\.(?:bin|thumb)")
        val backupName = Regex("comrade-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.zip")
    }

    internal data class Member(val size: Long, val sha256: String)
    private class Entry(val path: String, val size: Long) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
    }
    private data class Export(
        val name: String, val output: ZipOutputStream, val members: MutableMap<String, Member> = LinkedHashMap(),
        var active: Entry? = null, var total: Long = 0, var sealed: Boolean = false, var choosing: Boolean = false
    )
    private data class Verified(val id: String, val file: File, val paths: Set<String>)
    private var id: String? = null
    private var file: File? = null
    private var importing: OutputStream? = null
    private var importSize = 0L
    private var received = 0L
    private var exporting: Export? = null
    private val timeout = Runnable {
        val session = id
        clear()
        if (session != null) emit(session, "error", "Передача архива прервана", null)
    }
    @Volatile private var verified: Verified? = null

    fun command(session: String, type: String, data: JSONObject) {
        try {
            when (type) {
                "zip-export" -> startExport(session, data.getString("name"))
                "zip-import" -> startImport(session, data.getLong("size"))
                "zip-entry" -> if (id == session) beginEntry(session, data.getString("path"), data.getLong("size"))
                "zip-entry-end" -> if (id == session) endEntry(session)
                "zip-seal" -> if (id == session) seal(session)
                "zip-snapshot" -> if (id == session) seal(session, prepareSnapshot = true)
                "zip-validate" -> if (id == session) validate(session)
                "zip-cancel" -> if (id == session) clear()
            }
        } catch (_: Exception) {
            if (id == session) clear()
            emit(session, "error", "Не удалось обработать ZIP-архив", null)
        }
    }

    fun chunk(session: String, bytes: ByteArray, offset: Int): Boolean {
        if (id != session) return false
        try {
            val size = bytes.size - offset
            val output = importing
            if (output != null) {
                check(received + size <= importSize)
                output.write(bytes, offset, size)
                received += size
            } else {
                val archive = requireNotNull(exporting)
                val entry = requireNotNull(archive.active)
                check(entry.bytes + size <= entry.size)
                archive.output.write(bytes, offset, size)
                entry.digest.update(bytes, offset, size)
                entry.bytes += size
            }
            refreshTimeout()
            emit(session, "chunk", null, null)
        } catch (_: Exception) {
            clear()
            emit(session, "error", "Запись ZIP-архива прервана", null)
        }
        return true
    }

    private fun startImport(session: String, size: Long) {
        check(size in 1..MAX_TOTAL && id == null)
        initialize(session)
        importSize = size
        importing = requireNotNull(file).outputStream().buffered()
        emit(session, "begin", null, null)
    }

    private fun startExport(session: String, name: String) {
        check(backupName.matches(name) && id == null)
        initialize(session)
        exporting = Export(name, ZipOutputStream(requireNotNull(file).outputStream().buffered()).apply {
            setLevel(Deflater.BEST_SPEED)
        })
        emit(session, "begin", null, null)
    }

    private fun initialize(session: String) {
        file = File.createTempFile("comrade-zip-", ".part", context.cacheDir)
        id = session
        refreshTimeout()
    }

    private fun validMember(path: String, size: Long): Boolean =
        if (path == STATE) size in 1..MAX_METADATA
        else mediaName.matches(path) && size in 0..if (path.endsWith(".thumb")) 1024 * 1024L else MAX_FILE

    private fun beginEntry(session: String, path: String, size: Long) {
        val archive = requireNotNull(exporting)
        check(!archive.sealed && archive.active == null && archive.members.size < MAX_ENTRIES &&
            !archive.members.containsKey(path) && validMember(path, size) && archive.total + size <= MAX_TOTAL)
        archive.output.putNextEntry(ZipEntry(path))
        archive.active = Entry(path, size)
        refreshTimeout()
        emit(session, "entry", null, null)
    }

    private fun endEntry(session: String) {
        val archive = requireNotNull(exporting)
        val entry = requireNotNull(archive.active)
        check(entry.bytes == entry.size)
        archive.output.closeEntry()
        archive.members[entry.path] = Member(entry.bytes, entry.digest.digest().hex())
        archive.total += entry.size
        archive.active = null
        refreshTimeout()
        emit(session, "entry-end", null, null)
    }

    private fun seal(session: String, prepareSnapshot: Boolean = false) {
        val archive = requireNotNull(exporting)
        check(!archive.sealed && archive.active == null && archive.members.containsKey(STATE))
        val members = JSONArray()
        for ((path, entry) in archive.members) {
            members.put(JSONObject().put("path", path).put("size", entry.size).put("sha256", entry.sha256))
        }
        archive.output.putNextEntry(ZipEntry(MANIFEST))
        archive.output.write(JSONObject().put("format", FORMAT).put("version", 1)
            .put("entries", members).toString().toByteArray(Charsets.UTF_8))
        archive.output.close()
        archive.sealed = true
        if (prepareSnapshot) {
            val result = KanbanStorageSnapshot(context).prepare(requireNotNull(file), archive.members)
            clear()
            emit(session, "snapshot-ready", null, result)
            return
        }
        archive.choosing = true
        worker.removeCallbacks(timeout)
        choose(archive.name)
        emit(session, "choosing", null, null)
    }

    fun destination(uri: Uri?) {
        val session = id ?: return
        if (exporting?.choosing != true) return
        if (uri == null) {
            clear()
            emit(session, "cancelled", null, null)
            return
        }
        try {
            val source = requireNotNull(file)
            val written = requireNotNull(context.contentResolver.openOutputStream(uri, "wt")).use { out ->
                source.inputStream().use { it.copyTo(out, 64 * 1024) }
            }
            check(written == source.length())
            emit(session, "saved", null, null)
        } catch (_: Exception) {
            runCatching { context.contentResolver.delete(uri, null, null) }
            emit(session, "error", "Не удалось записать ZIP-архив", null)
        } finally { clear() }
    }

    private fun validate(session: String) {
        check(importing != null && importSize == received)
        importing?.close()
        importing = null
        val archive = requireNotNull(file)
        val paths = LinkedHashSet<String>()
        ZipFile(archive).use { zip ->
            check(zip.size() in 2..MAX_ENTRIES + 1)
            var total = 0L
            for (entry in zip.entries()) {
                check(!entry.isDirectory && paths.add(entry.name))
                if (entry.name == MANIFEST) check(entry.size in 1..2_000_000L)
                else {
                    check(validMember(entry.name, entry.size))
                    total += entry.size
                    check(total <= MAX_TOTAL)
                }
            }
            check(paths.remove(MANIFEST) && paths.contains(STATE))
            val index = zip.getEntry(MANIFEST)
            val manifest = zip.getInputStream(index).use { input ->
                val length = index.size.toInt()
                val bytes = ByteArray(length)
                check(java.io.DataInputStream(input).let { it.readFully(bytes); it.read() } == -1)
                JSONObject(String(bytes, Charsets.UTF_8))
            }
            check(manifest.getString("format") == FORMAT && manifest.getInt("version") == 1)
            val records = manifest.getJSONArray("entries")
            check(records.length() == paths.size)
            val unseen = paths.toMutableSet()
            val buffer = ByteArray(64 * 1024)
            for (i in 0 until records.length()) {
                val record = records.getJSONObject(i)
                val name = record.getString("path")
                check(unseen.remove(name))
                val entry = zip.getEntry(name)
                check(record.getLong("size") == entry.size)
                val digest = MessageDigest.getInstance("SHA-256")
                val crc = CRC32()
                var read = 0L
                zip.getInputStream(entry).use { input ->
                    while (true) {
                        val amount = input.read(buffer)
                        if (amount == -1) break
                        read += amount
                        check(read <= entry.size)
                        digest.update(buffer, 0, amount)
                        crc.update(buffer, 0, amount)
                    }
                }
                check(read == entry.size && crc.value == entry.crc && record.getString("sha256") == digest.digest().hex())
            }
        }
        verified = Verified(session, archive, paths)
        refreshTimeout(5 * 60_000L)
        emit(session, "verified", null, JSONObject().put("entries", JSONArray(paths)))
    }

    fun resource(path: String): WebResourceResponse {
        val ready = verified ?: return WebResourceResponse(null, null, null)
        if (!path.startsWith(ready.id + "/")) return WebResourceResponse(null, null, null)
        val name = path.substring(ready.id.length + 1)
        if (name !in ready.paths) return WebResourceResponse(null, null, null)
        return try {
            val zip = ZipFile(ready.file)
            try {
                val entry = zip.getEntry(name)
                val stream = object : FilterInputStream(zip.getInputStream(entry)) {
                    override fun close() { try { super.close() } finally { zip.close() } }
                }
                WebResourceResponse("application/octet-stream", null, 200, "OK",
                    mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
                        "Content-Length" to entry.size.toString()), stream)
            } catch (error: Exception) { zip.close(); throw error }
        } catch (_: Exception) { WebResourceResponse(null, null, null) }
    }

    private fun refreshTimeout(delay: Long = 30_000L) {
        worker.removeCallbacks(timeout)
        worker.postDelayed(timeout, delay)
    }

    fun clear() {
        worker.removeCallbacks(timeout)
        verified = null
        runCatching { importing?.close() }
        if (exporting?.sealed == false) runCatching { exporting?.output?.close() }
        file?.delete()
        importing = null
        exporting = null
        file = null
        id = null
        received = 0
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
