package com.kanban.offline

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

internal object KanbanPomodoro {
    const val ALARM = "com.kanban.offline.POMODORO"
    private const val CHANNEL = "comrade.pomodoro"
    private const val STATE_KEY = "timer"
    private val worker = Executors.newSingleThreadExecutor()
    private fun duration(mode: String) = if (mode == "focus") 25 * 60_000L else 5 * 60_000L
    private fun next(mode: String) = if (mode == "focus") "break" else "focus"

    private data class Timer(
        val mode: String, val remaining: Long, val elapsedEnd: Long, val wallEnd: Long,
        val boot: Int, val day: String, val sessions: Int
    ) {
        val running get() = elapsedEnd > 0 || wallEnd > 0
        fun json() = JSONObject().put("mode", mode).put("remaining", remaining).put("elapsedEnd", elapsedEnd)
            .put("wallEnd", wallEnd).put("boot", boot).put("day", day).put("sessions", sessions)

        fun paused(left: Long = duration(mode)) = copy(remaining = left, elapsedEnd = 0, wallEnd = 0)
        fun switched() = paused(duration(next(mode))).copy(mode = next(mode))
    }

    fun run(
        context: Context, action: String, legacy: JSONObject? = null,
        done: (JSONObject) -> Unit = {}
    ) {
        val app = context.applicationContext
        worker.execute {
            val result = try { update(app, action, legacy) }
            catch (_: Exception) { JSONObject().put("error", "Не удалось сохранить Pomodoro") }
            done(result)
        }
    }

    private fun update(context: Context, action: String, legacy: JSONObject?): JSONObject {
        val prefs = context.getSharedPreferences("comrade_pomodoro", Context.MODE_PRIVATE)
        val raw = prefs.getString(STATE_KEY, null)
        if (raw == null && action in setOf("alarm", "reboot", "clock")) return JSONObject()
        val today = LocalDate.now().toString()
        val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        val elapsed = SystemClock.elapsedRealtime()
        val wall = System.currentTimeMillis()
        val stored = raw?.let { JSONObject(it) }
        val source = stored ?: legacy ?: JSONObject()
        val mode = if (source.optString("mode") == "break") "break" else "focus"
        val original = Timer(mode, source.optLong("remaining", source.optLong("left", duration(mode) / 1000) * 1000)
            .coerceIn(0, duration(mode)), stored?.optLong("elapsedEnd") ?: 0L,
            stored?.optLong("wallEnd") ?: if (source.optBoolean("running")) source.optLong("end").coerceAtLeast(0) else 0L,
            stored?.optInt("boot", -1) ?: -1, source.optString("day", today),
            source.optInt("sessions").coerceIn(0, 100000))
        var timer = if (original.day == today) original else original.copy(day = today, sessions = 0)
        var complete: String? = null
        if (timer.running) {
            val left = if (timer.boot == boot && action != "reboot" && timer.elapsedEnd > 0) {
                timer.elapsedEnd - elapsed
            } else {
                timer.wallEnd - wall
            }
            if (left <= 0) {
                complete = timer.mode
                val finishDay = Instant.ofEpochMilli(wall + left).atZone(ZoneId.systemDefault()).toLocalDate().toString()
                timer = timer.switched().copy(sessions = timer.sessions +
                    if (timer.mode == "focus" && finishDay == today) 1 else 0)
            } else {
                val remaining = left.coerceAtMost(duration(timer.mode))
                timer = timer.copy(remaining = remaining, elapsedEnd = elapsed + remaining, wallEnd = wall + remaining, boot = boot)
            }
        }
        val starting = action == "toggle" && !timer.running && complete == null
        if (complete == null || action != "toggle") {
            timer = when (action) {
                "toggle" -> if (timer.running) timer.paused(timer.remaining) else {
                    val remaining = timer.remaining.takeIf { it > 0 } ?: duration(timer.mode)
                    timer.copy(remaining = remaining, elapsedEnd = elapsed + remaining, wallEnd = wall + remaining, boot = boot)
                }
                "reset" -> timer.paused()
                "skip" -> timer.switched()
                else -> timer
            }
        }
        val snapshot = timer.json().toString()
        if (raw != snapshot) check(prefs.edit().putString(STATE_KEY, snapshot).commit())
        schedule(context, timer)
        if (complete != null) notifyCompletion(context, complete)
        return JSONObject().put("mode", timer.mode).put("ms", timer.remaining)
            .put("running", timer.running).put("sessions", timer.sessions).put("started", starting)
            .put("completed", complete ?: JSONObject.NULL)
            .put("notificationsAllowed", notificationsAllowed(context))
    }

    private fun schedule(context: Context, timer: Timer) {
        val alarms = requireNotNull(context.getSystemService(AlarmManager::class.java))
        val intent = Intent(context, KanbanAlarmReceiver::class.java).setAction(ALARM)
        val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
        if (timer.running) alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, timer.elapsedEnd, pending)
        else alarms.cancel(pending)
    }

    private fun notificationsAllowed(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED) &&
            context.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true

    private fun notifyCompletion(context: Context, mode: String) {
        if (!notificationsAllowed(context)) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Pomodoro", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE)
        val note = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder).setContentTitle("Pomodoro")
            .setContentText(if (mode == "focus") "Сессия завершена. Перерыв 5 минут" else "Перерыв окончен")
            .setContentIntent(open).setAutoCancel(true).build()
        runCatching { manager.notify(1, note) }
    }
}

class KanbanAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == KanbanTaskReminders.ALARM) {
            val pending = goAsync()
            KanbanTaskReminders.run(context) { pending.finish() }
            return
        }
        val action = when (intent.action) {
            KanbanPomodoro.ALARM -> "alarm"
            Intent.ACTION_BOOT_COMPLETED -> "reboot"
            Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> "clock"
            else -> return
        }
        val pending = goAsync()
        val operations = AtomicInteger(if (action == "alarm") 1 else 2)
        val finish = { if (operations.decrementAndGet() == 0) pending.finish() }
        KanbanPomodoro.run(context, action) { finish() }
        if (action != "alarm") KanbanTaskReminders.run(context) { finish() }
    }
}
