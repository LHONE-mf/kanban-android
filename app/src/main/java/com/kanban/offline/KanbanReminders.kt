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

/** Local, offline, one-time task reminders. No server or background WebView required. */
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
        val at = json.optLong("at")
        if (at <= System.currentTimeMillis() || at > System.currentTimeMillis() + 366L * 24 * 3600_000) {
            prefs.edit().remove(id).apply()
            return
        }
        val title = json.optString("title").take(200).ifBlank { "Задача" }
        val record = JSONObject().put("id", id).put("title", title).put("at", at)
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
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) KanbanReminders.restore(context)
    }
}
