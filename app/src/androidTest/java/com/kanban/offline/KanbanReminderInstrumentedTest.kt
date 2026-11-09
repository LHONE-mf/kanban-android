package com.kanban.offline

import android.Manifest
import android.app.AlarmManager
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

    @Test fun firingRecurringReminderReschedulesAndShowsNotification() {
        schedule("daily", 1_000L)
        Thread.sleep(1200)
        KanbanReminders.fire(context, id)
        val record = JSONObject(requireNotNull(prefs.getString(id, null)))
        assertEquals("daily", record.getString("repeat"))
        assertTrue(record.getLong("at") > System.currentTimeMillis())
        assertTrue("Original repeat anchor must survive firing", record.getLong("anchorAt") < record.getLong("at"))
        assertTrue(context.getSystemService(NotificationManager::class.java)
            .activeNotifications.any { it.id == id.hashCode() })
    }
}
