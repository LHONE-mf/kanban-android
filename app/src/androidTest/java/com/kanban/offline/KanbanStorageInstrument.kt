package com.kanban.offline

import android.app.Activity
import android.app.Instrumentation
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
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
            checkVoiceDrafts(directory)
            checkZip(directory)
            checkPhotos(directory)
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "P19 Android SQLite, voice drafts, ZIP and photo checks passed\n") })
        } catch (failure: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", failure.stackTraceToString()) })
        } finally { directory.deleteRecursively() }
    }

    private fun checkZip(directory: File) {
        val session = "00000000-0000-4000-8000-000000000001"
        val importSession = "00000000-0000-4000-8000-000000000002"
        val events = ArrayList<String>()
        val exported = File(directory, "export.zip")
        val content = "test attachment".toByteArray()
        val state = """{"version":1}""".toByteArray()
        var destination: String? = null
        val backup = KanbanZipBackup(targetContext, Handler(Looper.getMainLooper()), { destination = it }) { _, type, _, _ -> events.add(type) }
        try {
            val filename = "comrade-backup-2026-11-26.zip"
            backup.command(session, "zip-export", JSONObject().put("name", filename))
            for ((path, bytes) in listOf("media/000000.bin" to content, "state.json" to state)) {
                backup.command(session, "zip-entry", JSONObject().put("path", path).put("size", bytes.size))
                check(backup.chunk(session, bytes, 0) && events.last() == "chunk")
                backup.command(session, "zip-entry-end", JSONObject())
            }
            backup.command(session, "zip-seal", JSONObject())
            check(destination == filename && events.last() == "choosing")
            backup.destination(Uri.fromFile(exported))
            check(events.last() == "saved" && exported.length() > 0)

            fun read(fixture: File) {
                backup.command(importSession, "zip-import", JSONObject().put("size", fixture.length()))
                check(backup.chunk(importSession, fixture.readBytes(), 0))
                backup.command(importSession, "zip-validate", JSONObject())
            }
            read(exported)
            check(events.last() == "verified")
            val restored = requireNotNull(backup.resource("$importSession/media/000000.bin").data).use { it.readBytes() }
            check(restored.contentEquals(content))
            backup.command(importSession, "zip-cancel", JSONObject())
            val damaged = File(directory, "damaged.zip")
            ZipFile(exported).use { source ->
                ZipOutputStream(damaged.outputStream()).use { output ->
                    for (entry in source.entries()) {
                        output.putNextEntry(ZipEntry(entry.name))
                        if (entry.name == "media/000000.bin") output.write(ByteArray(content.size))
                        else source.getInputStream(entry).use { it.copyTo(output) }
                        output.closeEntry()
                    }
                }
            }
            read(damaged)
            check(events.last() == "error" && backup.resource("$importSession/media/000000.bin").data == null)
        } finally { backup.clear() }
    }

    private fun checkPhotos(directory: File) {
        val png = File(directory, "transparent.png")
        val image = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
        try {
            val canvas = android.graphics.Canvas(image)
            val paint = android.graphics.Paint().apply { color = Color.RED }
            canvas.drawRect(0f, 0f, 320f, 480f, paint)
            png.outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        } finally { image.recycle() }
        val originalHash = sha(png.readBytes())
        val preview = KanbanPhotoProcessor.process(png, directory)
        try {
            check(preview.originalMime == "image/png" && preview.mime == "image/webp" && preview.full == null)
            check(sha(png.readBytes()) == originalHash)
            val thumbnail = BitmapFactory.decodeFile(preview.thumb.path)
            try {
                check(thumbnail.width == 320 && thumbnail.height == 240)
                check(Color.alpha(thumbnail.getPixel(250, 100)) == 0)
                check(Color.alpha(thumbnail.getPixel(60, 100)) == 255)
            } finally { thumbnail.recycle() }
        } finally { preview.delete() }

        val rotated = File(directory, "orientation6.jpg")
        val portrait = Bitmap.createBitmap(48, 80, Bitmap.Config.ARGB_8888)
        val jpeg = java.io.ByteArrayOutputStream()
        try { check(portrait.compress(Bitmap.CompressFormat.JPEG, 85, jpeg)) } finally { portrait.recycle() }
        val exif = byteArrayOf(69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
            0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0)
        val bytes = jpeg.toByteArray()
        rotated.outputStream().use { out ->
            out.write(bytes, 0, 2) // JPEG SOI.
            out.write(byteArrayOf(0xff.toByte(), 0xe1.toByte(), 0, (exif.size + 2).toByte()))
            out.write(exif)
            out.write(bytes, 2, bytes.size - 2)
        }
        val oriented = KanbanPhotoProcessor.process(rotated, directory)
        try {
            val thumbnail = BitmapFactory.decodeFile(oriented.thumb.path)
            try { check(thumbnail.width == 80 && thumbnail.height == 48) } finally { thumbnail.recycle() }
        } finally { oriented.delete() }
        check(runCatching { KanbanPhotoProcessor.process(File(directory, "invalid.jpg").apply { writeText("broken") }, directory) }.isFailure)
    }

    private fun checkVoiceDrafts(directory: File) {
        val root = File(directory, "drafts")
        val original = File(directory, "recording.m4a").apply { writeText("completed audio") }
        val owner = KanbanVoiceDrafts.Owner("board", "root", "r")
        val draft = KanbanVoiceDrafts(root).publish(original, owner, JSONObject().put("ms", 1200))
        check(!original.exists())
        val published = requireNotNull(draft.file.parentFile)
        check(published.renameTo(File(root, ".part-${draft.id}")))
        val reopened = KanbanVoiceDrafts(root)
        val recovered = reopened.list().single()
        check(recovered.id == draft.id && recovered.file.readText() == "completed audio")
        check(KanbanVoiceDrafts.Owner.from(recovered.metadata) == owner)
        check(reopened.open("../recording.m4a") == null)
        reopened.remove(draft.id)
        check(reopened.list().isEmpty())
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
