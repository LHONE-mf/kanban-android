package com.kanban.offline

import android.app.Activity
import android.app.Instrumentation
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject

/** Uses Android's real SQLite and private filesystem without launching the WebView. */
class KanbanStorageInstrument : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val directory = java.nio.file.Files.createTempDirectory(targetContext.cacheDir.toPath(), "snapshot-test").toFile()
        try {
            val root = File(directory, "private")
            val storage = KanbanStorageSnapshot(targetContext, root)
            val archive = File(directory, "fixture.zip")
            val first = createArchive(archive, "initial", "AAC bytes")
            val firstResult = storage.prepare(archive, first)
            check(firstResult.getInt("tasks") == 2 && firstResult.getInt("media") == 2 && firstResult.getInt("blobs") == 1)
            val published = File(root, "snapshot.sqlite")
            check(storage.prepare(archive, first).getInt("blobs") == 1)

            val next = createArchive(archive, "new snapshot", "updated AAC")
            val badDigest = next.toMutableMap()
            val member = badDigest.getValue("media/000001.bin")
            badDigest["media/000001.bin"] = member.copy(sha256 = "0".repeat(64))
            check(runCatching { storage.prepare(archive, badDigest) }.isFailure)
            check(title(published) == "initial" && !File(root, "pending.sqlite").exists())
            check(File(root, "blobs").listFiles()!!.size == 2) // Old generation and a reusable blob from the interrupted preparation.

            val brokenResult = createArchive(archive, "invalid", "updated AAC", "missing")
            check(runCatching { storage.prepare(archive, brokenResult) }.isFailure)
            check(title(published) == "initial")
            check(storage.prepare(archive, createArchive(archive, "new snapshot", "updated AAC")).getInt("blobs") == 1)
            check(File(root, "blobs").listFiles()!!.single().readText() == "updated AAC")
            SQLiteDatabase.openDatabase(published.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
                database.rawQuery("SELECT parent_id FROM tasks WHERE id='child'", null).use {
                    check(it.moveToFirst() && it.getString(0) == "root")
                }
                database.rawQuery("SELECT result_id FROM attachments WHERE task_id='child'", null).use {
                    check(it.moveToFirst() && it.getString(0) == "r")
                }
                database.rawQuery("SELECT payload FROM tasks WHERE id='root'", null).use {
                    check(it.moveToFirst() && JSONObject(it.getString(0)).getString("title") == "new snapshot")
                }
            }
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "P19 Android SQLite snapshot checks passed\n") })
        } catch (failure: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", failure.stackTraceToString()) })
        } finally { directory.deleteRecursively() }
    }

    private fun title(file: File): String =
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT payload FROM tasks WHERE id='root'", null).use {
                check(it.moveToFirst())
                JSONObject(it.getString(0)).getString("title")
            }
        }

    private fun createArchive(file: File, title: String, audio: String, result: String = "r"): Map<String, KanbanZipBackup.Member> {
        val state = JSONObject("""
            {
              "version":1, "activeBoardId":"board",
              "boards":[{"id":"board","name":"Fixture","columns":[{"id":"todo","isDone":false}]}],
              "tasks":[
                {"id":"child","parentId":"root","boardId":"board","columnId":"todo","title":"Child","order":1,"createdAt":1,"updatedAt":2,
                 "results":[{"id":"r","text":"Done"}],"checklist":[{"id":"c","text":"Check"}],"files":[{"id":"copy","resultId":"$result"}]},
                {"id":"root","parentId":"","boardId":"board","columnId":"todo","title":"$title","order":0,"createdAt":1,"updatedAt":2,
                 "results":[],"checklist":[],"files":[{"id":"original"}]}
              ],
              "media":[
                {"id":"original","path":"media/000000.bin","mime":"audio/mp4","size":${audio.length}},
                {"id":"copy","path":"media/000001.bin","mime":"audio/mp4","size":${audio.length}}
              ],
              "settings":{"day":1}, "web":{"kanban_theme":"dark"}, "nativeJapanese":null, "pomo":{"sessions":2}
            }
        """.trimIndent())
        val bytes = audio.toByteArray()
        val content = linkedMapOf("state.json" to state.toString().toByteArray(),
            "media/000000.bin" to bytes, "media/000001.bin" to bytes)
        ZipOutputStream(file.outputStream()).use { zip ->
            for ((name, value) in content) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(value)
                zip.closeEntry()
            }
        }
        return content.mapValues { KanbanZipBackup.Member(it.value.size.toLong(), sha(it.value)) }
    }

    private fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
}
