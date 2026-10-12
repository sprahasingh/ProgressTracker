# Notifications

### ID: reminder-limits
**Category:** notifications
**Question:** Do reminders arrive when the app is closed?
**Aliases:**
- Are reminders sent in the background?
- Why did I not get a push notification?
**Keywords:** notification, reminder, foreground, background, push
**Suggestible:** true
**Sources:**
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/capabilities.ts
**Answer:**
The current reminder monitor works while the app is open in the foreground. Background delivery depends on separate push delivery setup, so browser permission alone does not guarantee a reminder when the app is closed.

### ID: notification-preferences
**Category:** notifications
**Question:** Where can I change notification preferences?
**Aliases:**
- How do I turn reminders on or off?
- Can I change reminder settings?
**Keywords:** reminders, notifications, settings, browser permission
**Suggestible:** true
**Sources:**
- src/features/notifications/NotificationsSettings.tsx
- src/features/notifications/capabilities.ts
- src/features/notifications/NotificationsSettings.test.tsx
**Answer:**
Open Settings and find Notifications to review the available reminder preferences and device permission status. Available controls depend on browser and device support.

### ID: missing-checkin-reminder
**Category:** notifications
**Question:** How does the missing check-in reminder work?
**Aliases:**
- Why does Today show a missing check-in reminder?
- When are overdue check-ins highlighted?
**Keywords:** Today, missing check-in, overdue, reminder, schedule
**Suggestible:** true
**Sources:**
- src/features/today/TodayPage.tsx
- src/features/notifications/reminderRules.ts
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/reminderRules.test.ts
**Answer:**
The app can highlight unresolved check-in opportunities in its foreground experience, and History reviews missing opportunities from the previous seven completed days. These reminders depend on tracker schedules and active dates; they do not mean a saved check-in was deleted.
