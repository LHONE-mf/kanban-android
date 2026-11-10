package com.kanban.offline

import android.app.NotificationManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Notification actions cannot directly modify WebView IndexedDB while the app is
 * closed. Keep completion requests durably until the Kanban page commits them,
 * then acknowledge by matching the request token. No task contents are duplicated.
 */
internal object KanbanTaskActions {
    private const val PREFS = "kanban_pending_task_actions"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isPending(context: Context, taskId: String): Boolean =
        taskId.isNotBlank() && prefs(context).contains(taskId)

    fun queueDone(context: Context, taskId: String, boardId: String, notificationId: Int): Boolean {
        if (taskId.isBlank() || taskId.length > 200 || taskId.startsWith("snooze:")) return false
        val record = JSONObject()
            .put("action", "complete")
            .put("taskId", taskId)
            .put("boardId", boardId.take(200))
            .put("token", UUID.randomUUID().toString())
        // Persist before acknowledging or cancelling the notification. A process
        // death between these operations still leaves a recoverable action.
        if (!prefs(context).edit().putString(taskId, record.toString()).commit()) return false
        KanbanReminders.cancelTask(context, taskId)
        context.getSystemService(NotificationManager::class.java).cancel(notificationId)
        return true
    }

    fun pendingJson(context: Context): String {
        val pending = JSONArray()
        for (raw in prefs(context).all.values.filterIsInstance<String>().take(100)) {
            try { pending.put(JSONObject(raw)) } catch (_: Exception) { }
        }
        return pending.toString()
    }

    fun acknowledge(context: Context, taskId: String, token: String): Boolean {
        if (taskId.isBlank() || taskId.length > 200 || token.length != 36) return false
        val current = prefs(context).getString(taskId, null) ?: return false
        return try {
            if (JSONObject(current).optString("token") != token) false
            else prefs(context).edit().remove(taskId).commit()
        } catch (_: Exception) { false }
    }
}
