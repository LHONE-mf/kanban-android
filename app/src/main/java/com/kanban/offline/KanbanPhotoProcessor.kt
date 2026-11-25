package com.kanban.offline

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import java.io.File
import kotlin.math.roundToInt

internal object KanbanPhotoProcessor {
    private const val FULL_DIM = 1600
    private const val THUMB_DIM = 320
    private const val TARGET_BYTES = 2 * 1024 * 1024L
    private const val MAX_SOURCE_PIXELS = 150_000_000L

    data class Photo(val originalMime: String, val mime: String, val full: File?, val thumb: File) {
        fun delete() {
            full?.delete()
            thumb.delete()
        }
    }

    fun process(source: File, cache: File): Photo {
        val optimize = source.length() > TARGET_BYTES
        var originalMime = ""
        var animated = false
        val decoded = ImageDecoder.decodeBitmap(ImageDecoder.createSource(source)) { decoder, info, _ ->
            val width = info.size.width
            val height = info.size.height
            check(width > 0 && height > 0 && width.toLong() * height <= MAX_SOURCE_PIXELS)
            originalMime = info.mimeType
            check(originalMime in setOf("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"))
            animated = info.isAnimated
            val bound = if (optimize && !animated) FULL_DIM else THUMB_DIM
            val factor = maxOf(width, height).toDouble() / bound
            if (factor > 1) decoder.setTargetSize(
                (width / factor).roundToInt().coerceAtLeast(1),
                (height / factor).roundToInt().coerceAtLeast(1)
            )
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setOnPartialImageListener { false }
        }
        val outputMime = if (originalMime == "image/jpeg") "image/jpeg" else "image/webp"
        val format = if (outputMime == "image/jpeg") Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.WEBP_LOSSY
        var full: File? = null
        var thumb: File? = null
        try {
            if (optimize && !animated) {
                val candidate = File.createTempFile("photo-", ".tmp", cache)
                full = candidate
                encode(decoded, format, 82, candidate)
                if (candidate.length() > TARGET_BYTES) trySmaller(decoded, format, 68, candidate)
                if (candidate.length() > TARGET_BYTES && maxOf(decoded.width, decoded.height) > 1200) {
                    val smaller = scaled(decoded, 1200)
                    try { trySmaller(smaller, format, 72, candidate) } finally { smaller.recycle() }
                }
                if (candidate.length() >= source.length()) {
                    candidate.delete()
                    full = null
                }
            }
            val thumbnail = File.createTempFile("thumb-", ".tmp", cache)
            thumb = thumbnail
            val small = scaled(decoded, THUMB_DIM)
            try { encode(small, format, 78, thumbnail) } finally { if (small !== decoded) small.recycle() }
            return Photo(originalMime, outputMime, full, thumbnail)
        } catch (error: Exception) {
            full?.delete()
            thumb?.delete()
            throw error
        } finally { decoded.recycle() }
    }

    private fun scaled(bitmap: Bitmap, bound: Int): Bitmap {
        val scale = maxOf(bitmap.width, bitmap.height).toDouble() / bound
        if (scale <= 1) return bitmap
        return Bitmap.createScaledBitmap(
            bitmap, (bitmap.width / scale).roundToInt().coerceAtLeast(1),
            (bitmap.height / scale).roundToInt().coerceAtLeast(1), true
        )
    }

    private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int, path: File) {
        path.outputStream().buffered().use { check(bitmap.compress(format, quality, it)) }
        check(path.length() > 0)
    }

    private fun trySmaller(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int, current: File) {
        val alternative = File.createTempFile("photo-", ".tmp", current.parentFile)
        try {
            encode(bitmap, format, quality, alternative)
            if (alternative.length() < current.length()) alternative.renameTo(current)
        } finally { alternative.delete() }
    }
}
