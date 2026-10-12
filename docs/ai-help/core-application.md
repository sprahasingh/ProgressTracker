# Product map, account, and privacy

ProgressTracker stores personal activities as trackers and dated check-ins. It works locally first; signing in enables account synchronization. AI Help explains product behavior but has no permission to query personal trackers or make changes.

## Where features live

| Feature | Location | Main purpose |
| --- | --- | --- |
| Today | `/` | See today’s tracker opportunities and record check-ins. |
| Trackers | `/trackers` | Create, edit, pause, archive, restore, and organize tracker definitions. |
| Goals | `/goals` | Review saved goal plans, pacing, and milestones. |
| Calendar | `/calendar` | Review activity by date and navigate the calendar. |
| History | `/history` | Inspect past check-ins and their saved values. |
| Insights / Analytics | `/dashboard`, `/analytics` | Review progress summaries and per-measure observations. |
| Holidays & breaks | `/holidays` | Manage date-specific breaks that affect scheduled opportunities. |
| Settings | `/settings` | Change profile, sync, time-zone, appearance, notification, and account settings. |

The visible navigation groups some routes: Calendar includes History, and Insights includes Analytics, Achievements, and the dashboard. Route availability depends on account state for account-specific settings.

## Create a tracker

1. Open **Trackers** and choose **Create tracker** (or use the creation link from an empty Today view).
2. Choose Habit or Goal. Open **Challenge or project?** for those tracker kinds.
3. Enter a name, then choose the measure type and configure its values. New measures use Yes/No or Quantity.
4. Set the schedule, active dates, and any strict-mode behavior that fits the tracker.
5. Expand advanced settings to configure success rules, custom check-in fields, milestones, or goal planning when needed.
6. Save. The tracker is saved locally on this device; signed-in accounts synchronize it when online.

The setup page remains a single form. A validation error identifies the relevant field or section; correct it and submit again. If leaving a modified form, keep editing or explicitly discard the changes.

## Edit a tracker

Open the tracker from **Trackers**, then choose its edit action. You can update supported settings and add new measures. A saved measure’s type and historical interpretation are protected. Retire a measure with history to remove it from future check-ins while retaining the definition for old entries. Resolve rule, milestone, or plan dependencies before removing or retiring a measure.

Archiving or pausing a tracker changes whether it is active for future opportunities; it does not erase recorded history. Deleting to the Bin is a separate lifecycle action and follows the app’s restore/permanent-delete flow.

## Check-ins and custom fields

A check-in records the values for active measures on a date. Custom check-in fields, such as a short note or selected answer, add context to that entry; they are not measure values and are not used as numeric goal totals. A deliberate skip is different from recording a value. Editing the same date keeps the latest live revision for current calculations; deleted/tombstoned entries are excluded from current progress.

## Account, local data, and synchronization

Local tracker definitions, entries, and workspace preferences use browser storage. Signing in enables Supabase synchronization for account-owned records. When offline, local work remains on the device and sync can resume later. The sync engine uses revisions and records conflicts instead of silently combining incompatible tracker edits. Resolve a conflict from the app’s sync/conflict flow; do not assume both versions were merged.

Workspace time zone and appearance are saved locally for that workspace and currently do not synchronize across devices. A time-zone change changes date interpretation going forward; date-only check-in records are not shifted to a different date.

Account settings include profile-name edits, email-change confirmation, password controls in Sync & Data, notifications, account deletion, and workspace preferences. The app uses Supabase Auth for sign-in and profile/account operations. A user must confirm an email change through the sent verification message.

### Create an account and sign in

Open the account screen from **Settings** or the sign-in prompt. **Email me a sign-in link** sends a one-time email link; using an email for the first time creates an account, while using an existing account’s email signs that account in. To create an account with a password, choose **Create account**, enter an email and a password of at least eight characters, and submit. Existing password users can choose **Use password** and sign in with their email and password. A magic link is an alternative sign-in method and does not require setting a password.

Signed-in users can choose **Set or change password** under **Settings → Sync & Data** and save a new password of at least eight characters. **Forgot password?** sends an account recovery link; open it to choose a new password. Recovery and email confirmation continue to use Supabase’s email links. Depending on the project’s Secure email change setting, an email change may require links from both the current and new inboxes; until every required confirmation is completed, the current address remains active.

### Delete your account

Account deletion is available in the app for signed-in users under **Settings → Account Actions → Delete Account**. Review the permanent-deletion notice, enter the account password and the exact word `DELETE`, then choose **Permanently Delete Account**. Password verification is checked by the server and authorizes one deletion for up to five minutes. If you normally use email sign-in links, set a password first under **Settings → Sync & Data → Set or change password**. If the app says it could not reach the deletion service, keep the confirmation open and retry the deletion status when online; the server checks whether deletion already completed before trying again.

The app reports pending offline changes before the final confirmation; those changes are not uploaded as part of deletion. Export the workspace first if you want a copy. The server removes the Supabase Auth account and its account-owned cloud records. This device switches to guest mode and clears the deleted account's local workspace only after the server confirms deletion. Other devices can retain local copies and must be cleared separately. If the server cannot confirm the result, the app keeps local data and may pause synchronization until the deletion status is checked.

If deletion fails, read the message shown in the confirmation dialog and retry only after resolving its cause. For help, contact **spraha.progresstracker@gmail.com**. ProgressTracker does not require users to contact support to delete an account.

## Calendar, holidays, Insights, and achievements

The **Calendar** page shows activity by date. Use it to review where activity was recorded or an opportunity was missed; History provides the detailed saved values. The **Holidays & breaks** page manages date-only account holidays used by schedule-aware views. In Standard Mode, a holiday removes that date from expected opportunities; Strict Mode still requires activity on an active calendar day.

The **Insights** overview combines recent counts and consistency across active trackers, while keeping each tracker’s streak separate. Its activity heatmap shows daily completion relative to that date’s eligible opportunities; on narrow screens its automatic default shows a shorter range, and the user can select a period/year. The range choice is stored for the browser session. The **Achievements** section summarizes qualified check-ins, reward points, current/longest streaks, and streak milestones derived from saved entries. Points do not change tracker records or goals. When viewing all trackers, points and counts may be added, but different tracker streak lengths are not combined.

## Notifications and the Bin

Signed-in users can configure reminders under **Settings → Notifications**: reminders for today’s unmarked activities, unresolved activity from yesterday, optional partially completed targets, motivational messages, quiet hours, and daily caps. Reminder times use the workspace time zone and foreground checks run while the app is open. Device permission and push subscription registration do not mean closed-app delivery is available; the app explicitly reports that background sender/scheduler setup is not deployed. Guests do not have account notification preferences.

Deleted trackers appear on the separate **The Bin** page at **More → Bin** for a 30-day recovery period. The Bin shows **Restore**, which brings back the tracker and its saved progress/planning data, and **Permanently delete**, which permanently removes the tracker and its associated history after server confirmation. Production shows the permanent-delete action when the `VITE_ENABLE_PERMANENT_DELETION` build-time flag is `true`. The hosted manual deletion RPC and its permissions have been verified. Automatic cleanup is not configured because `pg_cron` is not installed; users should not expect trackers to be removed automatically after 30 days. Archiving, deleting into the Bin, restoring, and permanently deleting are different actions.

## Feedback and Support

Signed-in users can send a support query, bug report, feature request, or general feedback from **Settings → Feedback & Support** or the AI Help panel. In-app submissions are saved to the account’s support history and routed to ProgressTracker support. Users can review replies and respond under **Settings → My Support Queries**; resolved conversations are read-only, so a new query is needed to continue. Maintainer replies appear in the existing notification center and open the linked conversation. **Email Support** opens an external mail app and is not stored in the in-app support history. Account deletion removes that account’s feedback, support messages, notifications, and pending email jobs. AI Help sends only the text explicitly submitted in the support form, not the surrounding chat.

## Local backup

In **Settings → Sync & Data**, the local backup controls can download a workspace backup and restore a JSON backup into the same guest workspace or account. Restore previews additions and conflicts, adds missing records, skips identical records, and stops without changing data if IDs or dates conflict. A backup is a portability/recovery file; it is not proof that cloud synchronization succeeded. Keep it in a safe place because it can contain workspace records.

## AI Help privacy and availability

The browser sends the question, a bounded set of recent chat messages, and a fixed route identifier. It does not attach tracker definitions, check-in values, journals, goals, profile fields, or workspace preferences. The assistant cannot inspect a user’s personal records, edit the workspace, or execute actions.

Remote answers require an authenticated session and connectivity. A small local FAQ can answer selected common questions while signed out or offline; it cannot search the full product knowledge bundle. Provider, configuration, and rate-limit failures are shown with a recoverable message. Retry after any displayed cooldown.

Source references: `src/routes/router.tsx`, `src/app/AppShell.tsx`, `src/features/trackers/TrackerSetupPage.tsx`, `src/features/trackers/TrackerLibraryPage.tsx`, `src/features/trackers/TrackerBinPage.tsx`, `src/domain/trackers/schemaVersionGate.ts`, `supabase/migrations/20261010000100_tracker_bin_permanent_deletion.sql`, `src/features/today/TodayPage.tsx`, `src/features/dashboard/DashboardPage.tsx`, `src/features/dashboard/AchievementsPage.tsx`, `src/features/calendar/CalendarPage.tsx`, `src/features/holidays/HolidaysPage.tsx`, `src/features/auth/AuthPage.tsx`, `src/features/auth/AuthProvider.tsx`, `src/features/auth/authService.ts`, `src/features/auth/WorkspaceBackup.tsx`, `src/features/settings/AccountDeletion.tsx`, `src/config/supportContact.ts`, `src/features/feedback/SendFeedback.tsx`, `src/features/feedback/MySupportQueries.tsx`, `src/features/feedback/supportApi.ts`, `src/features/ai-knowledge/SupportInboxWorkspace.tsx`, `src/features/notifications/NotificationsSettings.tsx`, `src/components/NotificationCenter.tsx`, `src/features/settings/WorkspaceTimeZone.tsx`, `src/features/settings/appearance.ts`, `src/features/ai-help/AIHelpAssistant.tsx`, `src/features/ai-help/aiHelpService.ts`, `src/services/supabase/syncEngine.ts`, `src/db/localRepository.ts`, `src/db/database.ts`, `supabase/migrations/20261030000200_unified_feedback_support.sql`, `supabase/functions/send-feedback/index.ts`, `supabase/functions/support-inbox/index.ts`, `supabase/functions/ai-help-feedback/index.ts`, `supabase/functions/ai-help-review/index.ts`, `supabase/functions/ai-help/index.ts`, `supabase/functions/delete-account/index.ts`.
