package com.kanban.offline

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.os.Handler
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/** Runs entirely on the MediaTransfer worker, including the MediaPlayer callbacks. */
internal class KanbanAudioPlayer(
    private val context: Context,
    private val worker: Handler,
    private val emit: (String, String, String?, JSONObject?) -> Unit
) {
    private val manager = requireNotNull(context.getSystemService(AudioManager::class.java))
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
    private var focus: AudioFocusRequest? = null
    private var id: String? = null
    private var source: File? = null
    private var player: MediaPlayer? = null
    private var prepared = false
    private var playing = false
    private var rate = 1f
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) worker.post { pause() }
        }
    }
    private val tick = object : Runnable {
        override fun run() {
            if (!playing) return
            sendState()
            worker.postDelayed(this, 250)
        }
    }

    init {
        ContextCompat.registerReceiver(
            context, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    fun load(session: String, file: File) {
        reset()
        id = session
        source = file
        try {
            val audio = MediaPlayer()
            player = audio
            audio.setAudioAttributes(attributes)
            audio.setDataSource(file.absolutePath)
            audio.setOnPreparedListener {
                if (player !== audio) return@setOnPreparedListener
                prepared = true
                sendState("loaded")
            }
            audio.setOnCompletionListener {
                if (player !== audio) return@setOnCompletionListener
                playing = false
                abandonFocus()
                audio.seekTo(0)
                sendState()
            }
            audio.setOnSeekCompleteListener { if (player === audio) sendState() }
            audio.setOnErrorListener { _, _, _ ->
                if (player === audio) fail("Не удалось воспроизвести запись")
                true
            }
            audio.prepareAsync()
        } catch (_: Exception) { fail("Этот формат недоступен в плеере Android") }
    }

    fun command(session: String, type: String, data: JSONObject) {
        if (id != session) return
        if (type == "stop") { reset(); return }
        val audio = player?.takeIf { prepared } ?: return
        try {
            when (type) {
                "play" -> {
                    if (focus == null) {
                        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setAudioAttributes(attributes)
                            .setWillPauseWhenDucked(true)
                            .setOnAudioFocusChangeListener({ change ->
                                if (id == session && change < 0) pause()
                            }, worker).build()
                        if (manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                            emit(session, "unavailable", "Не удалось получить аудиофокус", null)
                            return
                        }
                        focus = request
                    }
                    seekFraction(audio, data)
                    val oldRate = rate
                    setRate(data)
                    if (!playing || oldRate != rate) audio.playbackParams = PlaybackParams().setSpeed(rate)
                    audio.start()
                    playing = true
                    worker.removeCallbacks(tick)
                    worker.post(tick)
                }
                "pause" -> pause()
                "seek" -> {
                    seekFraction(audio, data)
                    val offset = data.optInt("offset", 0).coerceIn(-5000, 5000)
                    if (offset != 0) audio.seekTo((audio.currentPosition + offset).coerceIn(0, audio.duration.coerceAtLeast(0)))
                }
                "rate" -> {
                    setRate(data)
                    // Applying non-zero PlaybackParams to a paused player would resume it.
                    if (playing) audio.playbackParams = PlaybackParams().setSpeed(rate)
                }
            }
        } catch (_: Exception) { fail("Не удалось воспроизвести запись") }
    }

    private fun setRate(data: JSONObject) {
        rate = when (data.optDouble("rate")) {
            1.5 -> 1.5f
            2.0 -> 2f
            else -> 1f
        }
    }

    private fun seekFraction(audio: MediaPlayer, data: JSONObject) {
        val fraction = data.optDouble("fraction")
        if (fraction in 0.0..1.0 && audio.duration > 0) audio.seekTo((fraction * audio.duration).toInt())
    }

    fun pause() {
        if (!playing) return
        try {
            player?.pause()
            playing = false
            worker.removeCallbacks(tick)
            abandonFocus()
            sendState()
        } catch (_: Exception) { fail("Не удалось остановить воспроизведение") }
    }

    private fun sendState(type: String = "state") {
        val session = id ?: return
        val audio = player ?: return
        val position = runCatching { audio.currentPosition }.getOrDefault(0)
        val duration = runCatching { audio.duration }.getOrDefault(0)
        emit(session, type, null, JSONObject().put("playing", playing)
            .put("t", position.coerceAtLeast(0) / 1000.0).put("dur", duration.coerceAtLeast(0) / 1000.0))
    }

    private fun abandonFocus() {
        focus?.let { manager.abandonAudioFocusRequest(it) }
        focus = null
    }

    private fun fail(message: String) {
        val session = id ?: return
        reset()
        emit(session, "error", message, null)
    }

    fun reset() {
        worker.removeCallbacks(tick)
        abandonFocus()
        runCatching { player?.release() }
        player = null
        source?.delete()
        source = null
        id = null
        playing = false
        prepared = false
        rate = 1f
    }

    fun close() {
        reset()
        context.unregisterReceiver(noisy)
    }
}
