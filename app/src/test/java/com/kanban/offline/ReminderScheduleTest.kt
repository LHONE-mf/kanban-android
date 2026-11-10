package com.kanban.offline

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.Before
import org.junit.After
import java.util.Calendar
import java.util.TimeZone

class ReminderScheduleTest {
    private lateinit var previousZone: TimeZone

    @Before fun useUtc() {
        previousZone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    @After fun restoreZone() { TimeZone.setDefault(previousZone) }

    private fun at(year: Int, month: Int, day: Int, hour: Int = 9): Long =
        Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(year, month - 1, day, hour, 0)
        }.timeInMillis

    @Test fun notificationShowsTaskBoardAndLocalReminderDate() {
        val reminderAt = at(2026, 11, 10, 9)
        assertEquals("10.11.2026 09:00", ReminderNotificationText.formatDate(reminderAt))
        assertEquals("Доска: Production · 10.11.2026 09:00",
            ReminderNotificationText.summary("Production", reminderAt))
    }

    @Test fun notificationUsesFallbackNameForMissingBoard() {
        assertEquals("Доска: Моя доска · 10.11.2026 09:00",
            ReminderNotificationText.summary("", at(2026, 11, 10, 9)))
    }

    @Test fun oneTimeDoesNotAdvance() {
        val due = at(2026, 11, 9)
        assertEquals(due, ReminderSchedule.nextTime(due, "none", due + 1000))
    }

    @Test fun dailySkipsMissedOccurrences() {
        assertEquals(at(2026, 11, 13), ReminderSchedule.nextTime(
            at(2026, 11, 9), "daily", at(2026, 11, 12, 10)))
    }

    @Test fun weeklyPreservesDayOfWeek() {
        assertEquals(at(2026, 11, 23), ReminderSchedule.nextTime(
            at(2026, 11, 9), "weekly", at(2026, 11, 16, 10)))
    }

    @Test fun monthlyDoesNotDriftAfterFebruary() {
        assertEquals(at(2027, 3, 31), ReminderSchedule.nextTime(
            at(2027, 1, 31), "monthly", at(2027, 2, 28, 10)))
        assertEquals(at(2027, 2, 28), ReminderSchedule.nextTime(
            at(2027, 1, 31), "monthly", at(2027, 1, 31, 10)))
    }

    @Test fun monthlyAnchorSurvivesMultipleDeliveries() {
        val originalAnchor = at(2027, 1, 31)
        val february = ReminderSchedule.nextTime(originalAnchor, "monthly", at(2027, 2, 1))
        assertEquals(at(2027, 2, 28), february)
        // A delivered reminder retains its January anchor instead of using February 28.
        val march = ReminderSchedule.nextTime(originalAnchor, "monthly", february)
        assertEquals(at(2027, 3, 31), march)
        val april = ReminderSchedule.nextTime(originalAnchor, "monthly", march)
        assertEquals(at(2027, 4, 30), april)
        val may = ReminderSchedule.nextTime(originalAnchor, "monthly", april)
        assertEquals(at(2027, 5, 31), may)
    }

    @Test fun monthlyAnchorSurvivesSeveralDeliveryCycles() {
        val anchor = at(2027, 1, 31)
        val february = ReminderSchedule.nextTime(anchor, "monthly", at(2027, 1, 31, 10))
        assertEquals(at(2027, 2, 28), february)
        // The persisted record must retain anchor, not replace it with February 28.
        val march = ReminderSchedule.nextTime(anchor, "monthly", february + 1000)
        assertEquals(at(2027, 3, 31), march)
        val april = ReminderSchedule.nextTime(anchor, "monthly", march + 1000)
        assertEquals(at(2027, 4, 30), april)
        val may = ReminderSchedule.nextTime(anchor, "monthly", april + 1000)
        assertEquals(at(2027, 5, 31), may)
    }

    @Test fun leapYearMonthlyRecurrence() {
        assertEquals(at(2028, 2, 29), ReminderSchedule.nextTime(
            at(2028, 1, 31), "monthly", at(2028, 2, 1)))
    }

    @Test fun unsupportedRecurrenceIsNotScheduledAsRepeat() {
        val due = at(2026, 11, 9)
        assertEquals(due, ReminderSchedule.nextTime(due, "invalid", due + 1000))
    }
    @Test fun dailyReminderKeepsLocalClockAcrossSpringDst() {
        val zone = TimeZone.getTimeZone("Europe/Berlin")
        TimeZone.setDefault(zone)
        fun berlin(year: Int, month: Int, day: Int, hour: Int): Long =
            Calendar.getInstance(zone).apply {
                clear()
                set(year, month - 1, day, hour, 0)
            }.timeInMillis
        val original = berlin(2027, 3, 27, 9)
        assertEquals(berlin(2027, 3, 28, 9),
            ReminderSchedule.nextTime(original, "daily", berlin(2027, 3, 27, 10)))
    }

    @Test fun weeklyReminderKeepsLocalClockAcrossAutumnDst() {
        val zone = TimeZone.getTimeZone("Europe/Berlin")
        TimeZone.setDefault(zone)
        fun berlin(year: Int, month: Int, day: Int, hour: Int): Long =
            Calendar.getInstance(zone).apply {
                clear()
                set(year, month - 1, day, hour, 0)
            }.timeInMillis
        val original = berlin(2027, 10, 24, 9)
        assertEquals(berlin(2027, 10, 31, 9),
            ReminderSchedule.nextTime(original, "weekly", berlin(2027, 10, 24, 10)))
    }

    @Test fun monthlyReminderKeepsLocalClockAcrossDst() {
        val zone = TimeZone.getTimeZone("Europe/Berlin")
        TimeZone.setDefault(zone)
        fun berlin(year: Int, month: Int, day: Int, hour: Int): Long =
            Calendar.getInstance(zone).apply {
                clear()
                set(year, month - 1, day, hour, 0)
            }.timeInMillis
        val anchor = berlin(2027, 1, 31, 9)
        assertEquals(berlin(2027, 2, 28, 9),
            ReminderSchedule.nextTime(anchor, "monthly", berlin(2027, 2, 1, 9)))
        assertEquals(berlin(2027, 3, 31, 9),
            ReminderSchedule.nextTime(anchor, "monthly", berlin(2027, 2, 28, 10)))
        assertEquals(berlin(2027, 4, 30, 9),
            ReminderSchedule.nextTime(anchor, "monthly", berlin(2027, 3, 31, 10)))
    }

}
