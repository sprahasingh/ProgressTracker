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

### ID: reminder-previous-day-only
**Category:** notifications
**Question:** How far back does the overdue reminder look?
**Aliases:**
- Does the reminder scan all old missed days?
- Will it notify me about every historical gap?
**Keywords:** overdue reminder, yesterday, historical, missed check-ins
**Suggestible:** true
**Sources:**
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/reminderRules.ts
**Answer:**
The overdue reminder checks unresolved opportunities from yesterday. It does not scan every historical date. History separately offers a review of missing opportunities from the previous seven completed days.

### ID: reminder-dismissal
**Category:** notifications
**Question:** Does dismissing a missing check-in reminder complete the date?
**Aliases:**
- If I close a reminder, is the check-in marked done?
- Does dismissing a notification resolve the missed day?
**Keywords:** dismiss reminder, mark complete, check-in, notification
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/reminderRules.ts
**Answer:**
No. Dismissing a notification changes the reminder’s read state; it does not create a check-in or mark the date complete. The date’s progress status changes only when you save or edit a check-in.

### ID: reminder-foreground-check
**Category:** notifications
**Question:** Why do reminders run only while ProgressTracker is open?
**Aliases:**
- Does the app check for reminders in the background?
- Why did no reminder arrive after I closed the app?
**Keywords:** foreground, background, scheduler, reminders, app open
**Suggestible:** true
**Sources:**
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/NotificationsSettings.tsx
**Answer:**
The reminder monitor evaluates reminders while the signed-in app is active. The Settings page reports that closed-app delivery still requires server-side sending and scheduling setup, so enabling device permission alone does not provide background reminders.

### ID: reminder-timezone-quiet
**Category:** notifications
**Question:** Which time zone and quiet hours affect reminders?
**Aliases:**
- Are notification times based on my workspace time zone?
- Why was a reminder delayed during quiet hours?
**Keywords:** reminder time, workspace time zone, quiet hours, schedule
**Suggestible:** true
**Sources:**
- src/features/notifications/NotificationsSettings.tsx
- src/features/notifications/reminderRules.ts
- src/features/notifications/ForegroundReminderMonitor.tsx
**Answer:**
Reminder times use the workspace time zone. Quiet hours suppress daily and motivation reminders; overdue reminders also pause during quiet hours unless their exception is enabled.

### ID: reminder-repeats-unresolved
**Category:** notifications
**Question:** Why can I get another reminder for the same unresolved date?
**Aliases:**
- Why did dismissing a reminder not stop later reminders?
- Can reminders repeat while I have not checked in?
**Keywords:** reminder, repeats, unresolved, daily schedule, dismissal
**Suggestible:** true
**Sources:**
- src/features/notifications/ForegroundReminderMonitor.tsx
- src/features/notifications/reminderRules.ts
- src/db/localRepository.ts
**Answer:**
Daily reminders are evaluated at their configured times while the app is active. Dismissing one marks that notification as read; it does not resolve the opportunity, so a later scheduled reminder can still appear while the check-in remains unresolved.
