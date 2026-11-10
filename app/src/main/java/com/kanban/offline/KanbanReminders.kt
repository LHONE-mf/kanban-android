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
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.text.SimpleDateFormat

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

/** Readable date and board details for an offline task notification. */
internal object ReminderNotificationText {
    fun formatDate(at: Long): String =
        SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date(at))
    fun summary(boardName: String, at: Long): String =
        "Доска: ${boardName.ifBlank { "Моя доска" }} · ${formatDate(at)}"
}

/** Local, offline task reminders. No server or background WebView required. */
object KanbanReminders {
    private const val PREFS = "kanban_native_reminders"
    private const val CHANNEL = "kanban_task_reminders"
    const val EXTRA_TASK_ID = "kanban_open_task_id"
    const val EXTRA_BOARD_ID = "kanban_open_board_id"
    private const val ACTION_SNOOZE = "com.kanban.offline.SNOOZE_REMINDER"
    private const val SNOOZE_PREFIX = "snooze:"
    private const val TEN_MINUTES = 10L * 60_000
    private fun requestCode(id: String) = id.hashCode()

    private fun intent(context: Context, id: String) =
        PendingIntent.getBroadcast(
            context, requestCode(id),
            Intent(context, KanbanReminderReceiver::class.java).putExtra("taskId", id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )


    /** Cancel both the ordinary recurrence and an outstanding one-time snooze. */
    fun cancelTask(context: Context, taskId: String) {
        if (taskId.isBlank() || taskId.length > 200) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val alarm = context.getSystemService(AlarmManager::class.java)
        val notifications = context.getSystemService(NotificationManager::class.java)
        for (key in listOf(taskId, SNOOZE_PREFIX + taskId)) {
            alarm.cancel(intent(context, key))
            prefs.edit().remove(key).apply()
            notifications.cancel(requestCode(key))
        }
    }

    fun update(context: Context, raw: String) {
        val json = JSONObject(raw)
        val id = json.optString("id").take(200)
        if (id.isBlank()) return
        // A queued completion takes precedence over the stale WebView state.
        // Otherwise app start/reconciliation could re-arm a dismissed reminder.
        val taskId = id.removePrefix(SNOOZE_PREFIX)
        if (KanbanTaskActions.isPending(context, taskId)) {
            cancelTask(context, taskId)
            return
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val alarm = context.getSystemService(AlarmManager::class.java)
        // Snoozes use a separate one-time alarm, so they cannot replace a task's
        // daily/weekly/monthly recurrence. Keep them on app reload if the original
        // task reminder is unchanged; cancel them on edits, completion or deletion.
        if (!id.startsWith(SNOOZE_PREFIX)) {
            val snoozeId = SNOOZE_PREFIX + id
            val previousSnooze = prefs.getString(snoozeId, null)
            if (previousSnooze != null) {
                val snoozed = JSONObject(previousSnooze)
                val sourceAt = json.optLong("anchorAt").takeIf { it > 0L } ?: json.optLong("at")
                if (sourceAt <= 0L || sourceAt != snoozed.optLong("sourceAt")) {
                    alarm.cancel(intent(context, snoozeId))
                    prefs.edit().remove(snoozeId).apply()
                    context.getSystemService(NotificationManager::class.java)
                        .cancel(requestCode(snoozeId))
                } else {
                    // Keep the pending snooze's name/board current after edits.
                    for (key in listOf("title", "boardId", "boardName")) {
                        if (json.has(key)) snoozed.put(key, json.optString(key))
                    }
                    prefs.edit().putString(snoozeId, snoozed.toString()).apply()
                }
            }
        }
        alarm.cancel(intent(context, id))
        val repeat = json.optString("repeat", "none").takeIf {
            it in setOf("none", "daily", "weekly", "monthly")
        } ?: "none"
        // Zero means cancel, including recurring alarms. Never treat Unix epoch as a repeat anchor.
        if (json.optLong("at") <= 0L) {
            prefs.edit().remove(id).apply()
            return
        }
        // Persist the original calendar anchor so Jan 31 -> Feb 28 -> Mar 31.
        val anchorAt = json.optLong("anchorAt").takeIf { it > 0L } ?: json.optLong("at")
        val at = ReminderSchedule.nextTime(anchorAt, repeat, System.currentTimeMillis())
        if (at <= System.currentTimeMillis() || at > System.currentTimeMillis() + 366L * 24 * 3600_000) {
            prefs.edit().remove(id).apply()
            return
        }
        val title = json.optString("title").take(200).ifBlank { "Задача" }
        val record = JSONObject().put("id", id).put("title", title).put("at", at)
            .put("anchorAt", anchorAt).put("repeat", repeat)
            .put("boardId", json.optString("boardId").take(200))
            .put("boardName", json.optString("boardName", "Моя доска").take(120))
        if (id.startsWith(SNOOZE_PREFIX)) {
            record.put("taskId", json.optString("taskId").take(200))
            record.put("sourceAt", json.optLong("sourceAt"))
        }
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

    fun snooze(context: Context, raw: String, notificationId: Int) {
        val fired = JSONObject(raw)
        val taskId = fired.optString("taskId").ifBlank { fired.optString("id") }.take(200)
        if (taskId.isBlank() || taskId.startsWith(SNOOZE_PREFIX)) return
        val sourceAt = fired.optLong("sourceAt").takeIf { it > 0L }
            ?: fired.optLong("anchorAt").takeIf { it > 0L }
            ?: return
        val snoozeId = SNOOZE_PREFIX + taskId
        val snoozed = JSONObject()
            .put("id", snoozeId).put("taskId", taskId)
            .put("title", fired.optString("title", "Задача"))
            .put("boardId", fired.optString("boardId"))
            .put("boardName", fired.optString("boardName", "Моя доска"))
            .put("sourceAt", sourceAt).put("repeat", "none")
            .put("at", System.currentTimeMillis() + TEN_MINUTES)
        update(context, snoozed.toString())
        context.getSystemService(NotificationManager::class.java).cancel(notificationId)
    }

    fun fire(context: Context, id: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(id, null) ?: return
        val json = JSONObject(raw)
        val taskId = json.optString("taskId").ifBlank { id }
        if (KanbanTaskActions.isPending(context, taskId)) {
            cancelTask(context, taskId)
            return
        }
        val firedAt = json.optLong("at")
        if (firedAt > System.currentTimeMillis() + 60_000) return
        prefs.edit().remove(id).apply()
        if (json.optString("repeat", "none") != "none") {
            val anchorAt = json.optLong("anchorAt").takeIf { it > 0L } ?: firedAt
            val next = ReminderSchedule.nextTime(anchorAt, json.optString("repeat"), System.currentTimeMillis())
            // Do not mutate the firing record: this notification must display
            // the occurrence that just fired, not its next scheduled repeat.
            if (next > System.currentTimeMillis()) {
                val nextRecord = JSONObject(json.toString()).put("at", next)
                update(context, nextRecord.toString())
            }
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Напоминания о задачах", NotificationManager.IMPORTANCE_DEFAULT))
        val boardName = json.optString("boardName", "Моя доска").ifBlank { "Моя доска" }
        val title = json.optString("title", "Задача")
        val date = ReminderNotificationText.formatDate(firedAt)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.kanban.offline.OPEN_TASK"
            data = Uri.parse("kanban://reminder/task/${Uri.encode(taskId)}")
            putExtra(EXTRA_TASK_ID, taskId)
            putExtra(EXTRA_BOARD_ID, json.optString("boardId"))
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val open = PendingIntent.getActivity(
            context, requestCode(id), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val snoozeIntent = Intent(context, KanbanReminderReceiver::class.java).apply {
            action = ACTION_SNOOZE
            data = Uri.parse("kanban://reminder/snooze/${Uri.encode(id)}")
            putExtra("snoozeRecord", json.toString())
            putExtra("notificationId", requestCode(id))
        }
        val snoozeAction = PendingIntent.getBroadcast(
            context, requestCode("action:$id"), snoozeIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val completeIntent = Intent(context, KanbanReminderReceiver::class.java).apply {
            action = "com.kanban.offline.MARK_DONE"
            data = Uri.parse("kanban://reminder/done/${Uri.encode(id)}")
            putExtra("taskId", taskId)
            putExtra("boardId", json.optString("boardId"))
            putExtra("notificationId", requestCode(id))
        }
        val completeAction = PendingIntent.getBroadcast(
            context, requestCode("done:$id"), completeIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(ReminderNotificationText.summary(boardName, firedAt))
            .setStyle(android.app.Notification.BigTextStyle()
                .bigText("Задача: $title\nДоска: $boardName\nНапоминание: $date"))
            .setContentIntent(open).setAutoCancel(true)
            .addAction(Notification.Action.Builder(
                android.R.drawable.ic_lock_idle_alarm, "Через 10 мин", snoozeAction
            ).build())
            .addAction(Notification.Action.Builder(
                android.R.drawable.checkbox_on_background, "Готово", completeAction
            ).build())
            .build()
        manager.notify(requestCode(id), notification)
    }
}

class KanbanReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "com.kanban.offline.MARK_DONE") {
            val taskId = intent.getStringExtra("taskId") ?: return
            val boardId = intent.getStringExtra("boardId") ?: ""
            KanbanTaskActions.queueDone(
                context, taskId, boardId, intent.getIntExtra("notificationId", 0)
            )
        } else if (intent.action == "com.kanban.offline.SNOOZE_REMINDER") {
            val raw = intent.getStringExtra("snoozeRecord") ?: return
            if (raw.length <= 2048) {
                try {
                    KanbanReminders.snooze(context, raw, intent.getIntExtra("notificationId", 0))
                } catch (_: Exception) { }
            }
        } else {
            intent.getStringExtra("taskId")?.let { KanbanReminders.fire(context, it) }
        }
    }
}

class KanbanReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) KanbanReminders.restore(context)
    }
}
