package com.kanban.offline

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.system.Os
import android.system.OsConstants
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.zip.ZipFile
import org.json.JSONArray
import org.json.JSONObject

/** Builds a private copy of IndexedDB data. The live WebView never reads or writes this copy. */
internal class KanbanStorageSnapshot(
    private val context: Context,
    private val root: File = File(context.noBackupFilesDir, "sqlite-snapshot")
) {
    private companion object {
        val lock = Any()
        val hashName = Regex("[0-9a-f]{64}")
        val binaryName = Regex("media/[0-9]{6}\\.bin")
        const val STATE = "state.json"
        const val MAX_STATE = 32L * 1024 * 1024
    }

    fun prepare(archive: File, members: Map<String, KanbanZipBackup.Member>): JSONObject = synchronized(lock) {
        check(root.isDirectory || root.mkdirs())
        val blobs = File(root, "blobs")
        check(blobs.isDirectory || blobs.mkdir())
        val staged = File(root, "pending.sqlite")
        val published = File(root, "snapshot.sqlite")
        SQLiteDatabase.deleteDatabase(staged)
        blobs.listFiles()?.filter { it.name.startsWith("blob-") && it.name.endsWith(".part") }?.forEach { it.delete() }
        val referenced = LinkedHashSet<String>()
        try {
            val result = ZipFile(archive).use { zip ->
                val metadata = members.getValue(STATE)
                check(metadata.size in 1..MAX_STATE)
                val bytes = ByteArray(metadata.size.toInt())
                val stateEntry = zip.getEntry(STATE)
                check(stateEntry.size == metadata.size)
                DataInputStream(zip.getInputStream(stateEntry)).use { input ->
                    input.readFully(bytes)
                    check(input.read() == -1)
                }
                check(sha256(bytes) == metadata.sha256)
                val state = JSONObject(String(bytes, Charsets.UTF_8))
                check(state.getInt("version") == 1)
                val tasks = state.getJSONArray("tasks")
                val boards = state.getJSONArray("boards")
                val media = state.getJSONArray("media")
                validateParents(tasks)
                SQLiteDatabase.openOrCreateDatabase(staged, null).use { db ->
                    db.disableWriteAheadLogging()
                    db.setForeignKeyConstraintsEnabled(true)
                    db.execSQL("PRAGMA synchronous=FULL")
                    val schema = context.assets.open("p19_storage.sql").bufferedReader().use { it.readText() }
                    for (statement in schema.split(';')) {
                        if (statement.isNotBlank()) db.execSQL(statement)
                    }
                    db.beginTransaction()
                    try {
                        insertBoards(db, boards)
                        insertMedia(db, zip, members, media, blobs, referenced)
                        insertTasks(db, tasks)
                        check(count(db, "SELECT count(*) FROM media m WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.media_id = m.id)") == 0)
                        for (key in listOf("settings", "web", "nativeJapanese", "pomo")) {
                            db.execSQL("INSERT INTO settings VALUES (?, ?)", arrayOf(key, state.get(key).toString()))
                        }
                        requirePayloads(db, "SELECT payload FROM boards ORDER BY position", boards)
                        requirePayloads(db, "SELECT payload FROM tasks ORDER BY rowid", tasks)
                        verifyDatabase(db)
                        syncDirectory(blobs)
                        db.execSQL("INSERT INTO snapshot VALUES (1, ?, ?, 'verified')",
                            arrayOf(metadata.sha256, state.getString("activeBoardId")))
                        db.setTransactionSuccessful()
                    } finally { db.endTransaction() }
                }
                SQLiteDatabase.openDatabase(staged.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
                    verifyDatabase(db)
                    check(count(db, "SELECT count(*) FROM snapshot") == 1)
                }
                JSONObject().put("tasks", tasks.length()).put("boards", boards.length())
                    .put("media", media.length()).put("blobs", referenced.size)
            }
            FileOutputStream(staged, true).use { it.fd.sync() }
            Os.rename(staged.path, published.path)
            syncDirectory(root)
            // The previous copy is no longer reachable. Failed copies keep all verified blobs for retry.
            blobs.listFiles()?.filter { hashName.matches(it.name) && it.name !in referenced }?.forEach { it.delete() }
            result
        } finally {
            SQLiteDatabase.deleteDatabase(staged)
        }
    }

    private fun insertBoards(db: SQLiteDatabase, boards: JSONArray) {
        check(boards.length() > 0)
        for (position in 0 until boards.length()) {
            val board = boards.getJSONObject(position)
            val id = board.getString("id")
            db.execSQL("INSERT INTO boards VALUES (?, ?, ?)", arrayOf(id, position, board.toString()))
            val columns = board.getJSONArray("columns")
            check(columns.length() > 0)
            for (index in 0 until columns.length()) {
                val column = columns.getJSONObject(index)
                db.execSQL("INSERT INTO columns VALUES (?, ?, ?, ?, ?)",
                    arrayOf(id, column.getString("id"), index, if (column.optBoolean("isDone")) 1 else 0, column.toString()))
            }
        }
    }

    private fun insertMedia(
        db: SQLiteDatabase, zip: ZipFile, members: Map<String, KanbanZipBackup.Member>, media: JSONArray,
        blobs: File, referenced: MutableSet<String>
    ) {
        val paths = members.keys.toMutableSet()
        check(paths.remove(STATE))
        for (index in 0 until media.length()) {
            val item = media.getJSONObject(index)
            val path = item.getString("path")
            check(binaryName.matches(path) && paths.remove(path))
            val full = publishBlob(zip, path, item.getLong("size"), members.getValue(path), blobs)
            if (referenced.add(full.sha256)) db.execSQL("INSERT INTO blobs VALUES (?, ?)", arrayOf(full.sha256, full.size))
            val preview = item.optJSONObject("thumb")
            val thumb = preview?.let {
                val thumbPath = it.getString("path")
                check(thumbPath == path.removeSuffix(".bin") + ".thumb" && paths.remove(thumbPath))
                publishBlob(zip, thumbPath, it.getLong("size"), members.getValue(thumbPath), blobs).also { member ->
                    if (referenced.add(member.sha256)) db.execSQL("INSERT INTO blobs VALUES (?, ?)", arrayOf(member.sha256, member.size))
                }
            }
            db.execSQL("INSERT INTO media VALUES (?, ?, ?, ?, ?)",
                arrayOf(item.getString("id"), full.sha256, thumb?.sha256, item.getString("mime"), preview?.getString("mime")))
        }
        check(paths.isEmpty())
    }

    private fun publishBlob(
        zip: ZipFile, path: String, size: Long, member: KanbanZipBackup.Member, directory: File
    ): KanbanZipBackup.Member {
        val entry = zip.getEntry(path)
        check(size == member.size && size == entry.size && hashName.matches(member.sha256))
        val file = File(directory, member.sha256)
        val valid = file.isFile && file.length() == size && file.inputStream().use { sha256(it, size) } == member.sha256
        if (valid) {
            check(zip.getInputStream(entry).use { sha256(it, size) } == member.sha256)
        } else {
            val temp = File.createTempFile("blob-", ".part", directory)
            try {
                FileOutputStream(temp).use { out ->
                    check(zip.getInputStream(entry).use { sha256(it, size, out) } == member.sha256)
                    out.fd.sync()
                }
                Os.rename(temp.path, file.path)
                check(file.inputStream().use { sha256(it, size) } == member.sha256)
            } finally { temp.delete() }
        }
        return member
    }

    private fun validateParents(tasks: JSONArray) {
        val parents = HashMap<String, String>()
        for (i in 0 until tasks.length()) {
            val task = tasks.getJSONObject(i)
            check(parents.put(task.getString("id"), task.getString("parentId")) == null)
        }
        val checked = HashSet<String>()
        for (id in parents.keys) {
            val path = HashSet<String>()
            var next = id
            while (next.isNotEmpty() && next !in checked) {
                check(path.add(next))
                next = parents.getValue(next)
            }
            checked.addAll(path)
        }
    }

    private fun insertTasks(db: SQLiteDatabase, tasks: JSONArray) {
        for (index in 0 until tasks.length()) {
            val task = tasks.getJSONObject(index)
            val id = task.getString("id")
            db.execSQL("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(
                id, task.getString("boardId"), task.getString("columnId"), task.getString("parentId").ifEmpty { null },
                task.getDouble("order"), task.getLong("createdAt"), task.getLong("updatedAt"),
                if (task.isNull("completedAt")) null else task.getLong("completedAt"), task.toString()
            ))
            for ((field, statement) in listOf(
                "results" to "INSERT INTO task_results VALUES (?, ?, ?, ?)",
                "checklist" to "INSERT INTO checklist_items VALUES (?, ?, ?, ?)"
            )) {
                val entries = task.optJSONArray(field) ?: continue
                for (i in 0 until entries.length()) {
                    val entry = entries.getJSONObject(i)
                    db.execSQL(statement, arrayOf(id, entry.getString("id"), i, entry.toString()))
                }
            }
            val files = task.getJSONArray("files")
            for (i in 0 until files.length()) {
                val entry = files.getJSONObject(i)
                db.execSQL("INSERT INTO attachments VALUES (?, ?, ?, ?, ?)", arrayOf(
                    id, i, entry.getString("id"), entry.optString("resultId").ifEmpty { null }, entry.toString()
                ))
            }
        }
    }

    private fun requirePayloads(db: SQLiteDatabase, sql: String, expected: JSONArray) {
        db.rawQuery(sql, null).use { rows ->
            for (i in 0 until expected.length()) {
                check(rows.moveToNext() && rows.getString(0) == expected.getJSONObject(i).toString())
            }
            check(!rows.moveToNext())
        }
    }

    private fun verifyDatabase(db: SQLiteDatabase) {
        db.rawQuery("PRAGMA foreign_key_check", null).use { check(!it.moveToFirst()) }
        db.rawQuery("PRAGMA integrity_check", null).use { check(it.moveToFirst() && it.getString(0) == "ok") }
    }

    private fun count(db: SQLiteDatabase, sql: String): Int =
        db.rawQuery(sql, null).use { check(it.moveToFirst()); it.getInt(0) }

    private fun syncDirectory(directory: File) {
        val fd = Os.open(directory.path, OsConstants.O_RDONLY or OsConstants.O_DIRECTORY, 0)
        try { Os.fsync(fd) } finally { Os.close(fd) }
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).hex()

    private fun sha256(input: java.io.InputStream, size: Long, out: OutputStream? = null): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read == -1) break
            total += read
            check(total <= size)
            digest.update(buffer, 0, read)
            out?.write(buffer, 0, read)
        }
        check(total == size)
        return digest.digest().hex()
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
