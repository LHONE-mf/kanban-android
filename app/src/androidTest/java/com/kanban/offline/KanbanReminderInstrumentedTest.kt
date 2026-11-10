package com.kanban.offline

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Runs on a disposable CI emulator; never clears user data. */
class KanbanReminderInstrumentedTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefs get() = context.getSharedPreferences("kanban_native_reminders", Context.MODE_PRIVATE)
    private val id = "ci-reminder-instrumentation"

    @Before fun resetFixture() {
        KanbanReminders.update(context, JSONObject().put("id", id).put("at", 0).toString())
        context.getSystemService(NotificationManager::class.java).cancel(id.hashCode())
    }

    @After fun cleanupFixture() = resetFixture()

    private fun schedule(repeat: String = "none", offset: Long = 120_000L): Long {
        val at = System.currentTimeMillis() + offset
        KanbanReminders.update(context, JSONObject()
            .put("id", id).put("title", "CI reminder delivery")
            .put("boardId", "ci-board").put("boardName", "CI Production")
            .put("at", at).put("repeat", repeat).toString())
        return at
    }

    @Test fun schedulingPersistsAndCancellationRemovesRecord() {
        val at = schedule("weekly")
        val record = JSONObject(requireNotNull(prefs.getString(id, null)))
        assertEquals("weekly", record.getString("repeat"))
        assertEquals(at, record.getLong("at"))
        assertEquals("Initial reminder must preserve its recurrence anchor", at, record.getLong("anchorAt"))
        KanbanReminders.update(context, JSONObject().put("id", id).put("at", 0).put("repeat", "weekly").toString())
        assertNull(prefs.getString(id, null))
    }

    @Test fun bootRecoveryKeepsFutureReminder() {
        val at = schedule("daily")
        KanbanReminders.restore(context)
        val record = JSONObject(requireNotNull(prefs.getString(id, null)))
        assertEquals("daily", record.getString("repeat"))
        assertEquals(at, record.getLong("at"))
        assertEquals(at, record.getLong("anchorAt"))
        assertEquals("ci-board", record.getString("boardId"))
        assertEquals("CI Production", record.getString("boardName"))
    }

    @Test fun firingOneTimeReminderShowsNativeNotification() {
        if (Build.VERSION.SDK_INT >= 33) {
            assertEquals("CI must grant POST_NOTIFICATIONS", PackageManager.PERMISSION_GRANTED,
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS))
        }
        schedule(offset = 1_000L)
        Thread.sleep(1200)
        KanbanReminders.fire(context, id)
        val notifications = context.getSystemService(NotificationManager::class.java).activeNotifications
        assertTrue("Expected task notification", notifications.any { it.id == id.hashCode() })
        assertNull("One-time reminder must be consumed", prefs.getString(id, null))
    }

    @Test fun snoozeActionSchedulesOnlyTenMinutesAndSurvivesAppReconciliation() {
        val originalAt = schedule(offset = 1_000L)
        Thread.sleep(1200)
        KanbanReminders.fire(context, id)
        val notification = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.first { it.id == id.hashCode() }.notification
        val snoozeAction = notification.actions?.firstOrNull {
            it.title.toString().contains("10 мин")
        }
        assertNotNull("Notification must have a snooze action", snoozeAction)
        snoozeAction!!.actionIntent.send()
        val snoozeKey = "snooze:$id"
        var saved = prefs.getString(snoozeKey, null)
        for (attempt in 0 until 25) {
            if (saved != null) break
            Thread.sleep(80)
            saved = prefs.getString(snoozeKey, null)
        }
        assertNotNull("Snooze must save a separate native alarm", saved)
        val record = JSONObject(saved!!)
        assertEquals(id, record.getString("taskId"))
        assertEquals(originalAt, record.getLong("sourceAt"))
        assertEquals("CI Production", record.getString("boardName"))
        assertEquals("none", record.getString("repeat"))
        assertTrue("Snooze should be scheduled about ten minutes out",
            record.getLong("at") in (System.currentTimeMillis() + 540_000L)..(System.currentTimeMillis() + 610_000L))

        // Opening the app does not overwrite the pending snooze.
        KanbanReminders.update(context, JSONObject().put("id", id)
            .put("at", originalAt).put("repeat", "none").toString())
        assertNotNull("Unchanged reminder must preserve snooze", prefs.getString(snoozeKey, null))
        KanbanReminders.restore(context)
        assertNotNull("Boot restore must preserve snooze", prefs.getString(snoozeKey, null))

        KanbanReminders.update(context, JSONObject().put("id", id)
            .put("at", System.currentTimeMillis() + 3_600_000L).toString())
        assertNull("Changing the reminder must cancel stale snooze", prefs.getString(snoozeKey, null))
    }

    @Test fun snoozingRecurringOccurrenceDoesNotDelayNextRegularReminder() {
        schedule("daily", 1_000L)
        Thread.sleep(1200)
        KanbanReminders.fire(context, id)
        val nextRegular = JSONObject(requireNotNull(prefs.getString(id, null))).getLong("at")
        val notification = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.first { it.id == id.hashCode() }.notification
        val snoozeAction = notification.actions?.firstOrNull {
            it.title.toString().contains("10 мин")
        }
        assertNotNull("Recurring notification must offer snooze", snoozeAction)
        snoozeAction!!.actionIntent.send()
        for (attempt in 0 until 25) {
            if (prefs.getString("snooze:$id", null) != null) break
            Thread.sleep(80)
        }
        assertNotNull("Snoozed occurrence must be scheduled", prefs.getString("snooze:$id", null))
        assertEquals("Next normal recurrence must remain untouched", nextRegular,
            JSONObject(requireNotNull(prefs.getString(id, null))).getLong("at"))
    }

    @Test fun firingRecurringReminderReschedulesAndShowsNotification() {
        val firedAt = schedule("daily", 1_000L)
        Thread.sleep(1200)
        KanbanReminders.fire(context, id)
        val record = JSONObject(requireNotNull(prefs.getString(id, null)))
        assertEquals("daily", record.getString("repeat"))
        assertTrue(record.getLong("at") > System.currentTimeMillis())
        assertTrue("Original repeat anchor must survive firing", record.getLong("anchorAt") < record.getLong("at"))
        val shown = context.getSystemService(NotificationManager::class.java)
            .activeNotifications.firstOrNull { it.id == id.hashCode() }?.notification
        assertNotNull("Recurring notification must display", shown)
        val details = shown!!.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString()
        assertTrue("Notification must show the board name", details.contains("CI Production"))
        assertTrue("Show the fired occurrence rather than tomorrow's new alarm",
            details.contains(ReminderNotificationText.formatDate(firedAt)))
        assertFalse("Do not show the next scheduled date in today's notification",
            details.contains(ReminderNotificationText.formatDate(record.getLong("at"))))
    }
}
