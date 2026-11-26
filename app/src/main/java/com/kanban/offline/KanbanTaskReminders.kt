package com.kanban.offline

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

internal object KanbanTaskReminders {
    const val ALARM = "com.kanban.offline.TASK_REMINDERS"
    const val OPEN = "com.kanban.offline.OPEN_REMINDER"
    const val TASK = "task"
    const val BOARD = "board"
    private const val CHANNEL = "comrade.task.reminders"
    private const val NOTIFICATION = 2
    private const val GRACE_MS = 60 * 60_000L
    private val worker = Executors.newSingleThreadExecutor()

    private data class Reminder(
        val task: String, val board: String, val title: String, val date: LocalDate, val time: LocalTime
    ) {
        val scheduleKey get() = "$board\n$date\n$time"
        fun deadline(zone: ZoneId) = date.atTime(time).atZone(zone).toInstant().toEpochMilli()
    }

    fun run(context: Context, rows: JSONArray? = null, done: (Boolean) -> Unit = {}) {
        val app = context.applicationContext
        worker.execute { done(runCatching { reconcile(app, rows); true }.getOrDefault(false)) }
    }

    fun validId(value: String): Boolean =
        value.length in 1..200 && value.none { it.isISOControl() }

    private fun parse(rows: JSONArray): Map<String, Reminder> {
        check(rows.length() <= 1500)
        return buildMap {
            for (i in 0 until rows.length()) {
                val data = rows.getJSONObject(i)
                val task = data.getString(TASK)
                val board = data.getString(BOARD)
                val title = data.getString("title")
                check(validId(task) && validId(board) && title.length <= 200 && !containsKey(task))
                put(task, Reminder(task, board, title,
                    LocalDate.parse(data.getString("date")), LocalTime.parse(data.getString("time"))))
            }
        }
    }

    private fun reconcile(context: Context, replacement: JSONArray?) {
        val prefs = context.getSharedPreferences("comrade_task_reminders", Context.MODE_PRIVATE)
        val oldRows = JSONArray(prefs.getString("rows", "[]"))
        val old = parse(oldRows)
        val active = if (replacement != null) parse(replacement) else old
        val delivered = JSONObject(prefs.getString("delivered", "{}"))
        val marks = JSONObject()
        val now = System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        val due = ArrayList<Reminder>()
        var earliest = Long.MAX_VALUE
        for ((task, reminder) in active) {
            val at = reminder.deadline(zone)
            val sameSchedule = old[task]?.scheduleKey == reminder.scheduleKey
            if (sameSchedule && delivered.optString(task) == reminder.scheduleKey) {
                marks.put(task, reminder.scheduleKey)
            } else if (at <= now) {
                if (sameSchedule && at >= now - GRACE_MS) due.add(reminder)
                // Past deadlines cannot fire after a clock change or repeated refresh.
                marks.put(task, reminder.scheduleKey)
            } else {
                earliest = minOf(earliest, at)
            }
        }
        check(prefs.edit().putString("rows", (replacement ?: oldRows).toString())
            .putString("delivered", marks.toString()).commit())

        val manager = requireNotNull(context.getSystemService(NotificationManager::class.java))
        for ((task, reminder) in old) {
            if (active[task]?.scheduleKey != reminder.scheduleKey) manager.cancel(task, NOTIFICATION)
        }
        val alarm = requireNotNull(context.getSystemService(AlarmManager::class.java))
        val pending = PendingIntent.getBroadcast(context, 0,
            Intent(context, KanbanAlarmReceiver::class.java).setAction(ALARM), PendingIntent.FLAG_IMMUTABLE)
        if (earliest < Long.MAX_VALUE) alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, earliest, pending)
        else alarm.cancel(pending)
        if (!manager.areNotificationsEnabled()) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Напоминания о задачах", NotificationManager.IMPORTANCE_DEFAULT))
        for (reminder in due) notify(context, manager, reminder)
    }

    private fun notify(context: Context, manager: NotificationManager, reminder: Reminder) {
        val identity = Uri.Builder().scheme("comrade").authority("reminder")
            .appendPath(reminder.board).appendPath(reminder.task).build()
        val destination = Intent(context, MainActivity::class.java).setAction(OPEN).setData(identity)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val open = PendingIntent.getActivity(context, 0, destination, PendingIntent.FLAG_IMMUTABLE)
        val note = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder).setContentTitle("Напоминание о задаче")
            .setContentText(reminder.title).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(open).setAutoCancel(true).build()
        runCatching { manager.notify(reminder.task, NOTIFICATION, note) }
    }
}
