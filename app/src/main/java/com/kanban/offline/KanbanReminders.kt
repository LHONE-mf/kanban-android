package com.kanban.offline

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Calendar

/** Pure recurrence calculation; calendar arithmetic respects local daylight-saving changes. */
internal object ReminderSchedule {
    fun nextTime(at: Long, repeat: String, now: Long): Long {
        if (repeat == "none" || repeat !in setOf("daily", "weekly", "monthly")) return at
        val date = Calendar.getInstance().apply { timeInMillis = at }
        val originalDay = date.get(Calendar.DAY_OF_MONTH)
        if (repeat == "monthly") {
            // Jump directly from the original anchor, avoiding drift from short months.
            val anchor = Calendar.getInstance().apply { timeInMillis = at }
            var months = 0
            while (date.timeInMillis <= now) {
                months++
                date.timeInMillis = anchor.timeInMillis
                date.set(Calendar.DAY_OF_MONTH, 1)
                date.add(Calendar.MONTH, months)
                date.set(Calendar.DAY_OF_MONTH, minOf(originalDay, date.getActualMaximum(Calendar.DAY_OF_MONTH)))
            }
        } else {
            while (date.timeInMillis <= now) {
                date.add(if (repeat == "daily") Calendar.DAY_OF_MONTH else Calendar.WEEK_OF_YEAR, 1)
            }
        }
        return date.timeInMillis
    }
}

/** Local, offline task reminders. No server or background WebView required. */
object KanbanReminders {
    private const val PREFS = "kanban_native_reminders"
    private const val CHANNEL = "kanban_task_reminders"
    private fun requestCode(id: String) = id.hashCode()

    private fun intent(context: Context, id: String) =
        PendingIntent.getBroadcast(
            context, requestCode(id),
            Intent(context, KanbanReminderReceiver::class.java).putExtra("taskId", id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )


    fun update(context: Context, raw: String) {
        val json = JSONObject(raw)
        val id = json.optString("id").take(200)
        if (id.isBlank()) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val alarm = context.getSystemService(AlarmManager::class.java)
        alarm.cancel(intent(context, id))
        val repeat = json.optString("repeat", "none").takeIf {
            it in setOf("none", "daily", "weekly", "monthly")
        } ?: "none"
        // Zero means cancel, including recurring alarms. Never treat Unix epoch as a repeat anchor.
        if (json.optLong("at") <= 0L) {
            prefs.edit().remove(id).apply()
            return
        }
        val at = ReminderSchedule.nextTime(json.optLong("at"), repeat, System.currentTimeMillis())
        if (at <= System.currentTimeMillis() || at > System.currentTimeMillis() + 366L * 24 * 3600_000) {
            prefs.edit().remove(id).apply()
            return
        }
        val title = json.optString("title").take(200).ifBlank { "Задача" }
        val record = JSONObject().put("id", id).put("title", title).put("at", at).put("repeat", repeat)
        prefs.edit().putString(id, record.toString()).apply()
        // setAndAllowWhileIdle is intentionally inexact; no special exact-alarm permission.
        alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent(context, id))
    }

    fun restore(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.all.values.filterIsInstance<String>().forEach { raw ->
            try { update(context, raw) } catch (_: Exception) { }
        }
    }

    fun fire(context: Context, id: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(id, null) ?: return
        val json = JSONObject(raw)
        if (json.optLong("at") > System.currentTimeMillis() + 60_000) return
        prefs.edit().remove(id).apply()
        if (json.optString("repeat", "none") != "none") {
            val next = ReminderSchedule.nextTime(json.optLong("at"), json.optString("repeat"), System.currentTimeMillis())
            if (next > System.currentTimeMillis()) update(context, json.put("at", next).toString())
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Напоминания о задачах", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            context, requestCode(id), Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = android.app.Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Напоминание · Канбан")
            .setContentText(json.optString("title"))
            .setContentIntent(open).setAutoCancel(true).build()
        manager.notify(requestCode(id), notification)
    }
}

class KanbanReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        intent.getStringExtra("taskId")?.let { KanbanReminders.fire(context, it) }
    }
}

class KanbanReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) KanbanReminders.restore(context)
    }
}
