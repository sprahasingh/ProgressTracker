# Check-ins, History, Analytics, and synchronization

## Check-in records and History

A check-in belongs to a tracker and date and stores values by stable measure ID. The tracker definition supplies the labels, units, and types used to interpret those values. Editing a measure with saved history is restricted so old values keep their meaning. Retiring the measure removes it from future check-in forms, but the definition remains for historical rendering. Custom fields with saved values follow the same preservation rule: their label, type, options, and required setting cannot be changed or removed. Retiring a field hides it from new forms; old values remain visible and are carried through when that entry is resaved.

History lets you review recorded and skipped dates and see each saved measure value with its name and unit. A legacy Checklist is rendered as a checked-item count while its retained item states preserve the old context. Retired measures can still appear in past entries. The latest live revision for a date is used; deleted/tombstoned entries are not treated as current activity.

To troubleshoot a missing value, confirm the tracker and date filters, whether the check-in is recorded or skipped, whether a later revision replaced it, and whether an entry was deleted. Pausing or archiving a tracker does not erase its saved history.

## Analytics

Analytics can summarize **All Trackers** or an individual tracker over the selected 7-, 30-, or 90-day window. Aggregate counts such as check-ins and eligible opportunities can be compared across trackers; values with different units are not combined. Each measure gets its own observation count, average, latest value, and dated trend. Boolean values are represented as yes/no observations; a Checklist is represented by the number of checked items.

The summary is grouped into Activity (saved check-ins, Success Rule matches, and their rate), Consistency (eligible opportunities, successful opportunities, and Streak Rule-qualified tracker dates), and XP & rewards. In All Trackers, comparable counts are summed across trackers, so a calendar date can contribute once for each tracker. Account XP, tracker-attributed XP, and the remaining account XP use the selected period; pending local rewards are included. The badge count is lifetime scoped: All Trackers counts distinct earned badge types, while an individual tracker counts active badge unlocks linked to that tracker. Holidays remain an account-wide count for the selected period. When the period has no check-ins or eligible opportunities, a single contextual message explains the empty state; an undefined rate is shown as unavailable rather than 0%.

Consistency is qualified eligible opportunities divided by elapsed opportunities. The current unlogged day remains open and is not included as a missed opportunity. Standard Mode counts scheduled non-holiday dates; Strict Mode counts every active calendar day. Rest days and holidays are excluded in Standard Mode and required in Strict Mode. The tracker’s active date range and schedule constrain opportunities. A recorded value may be present in the metric trend without qualifying toward consistency if it fails the success rule.

Retired measures remain part of historical metric summaries because their definitions are retained. Analytics does not combine their observations with another measure or unit.

Wins emphasizes lifetime confirmed XP, level progress, achievements, badges, milestones, and reward history. A compact seven-day confirmed XP total appears with Score history; unlike the period XP in Analytics, it excludes pending rewards. Its account consistency score is a separate rolling measure: it averages the per-day share of successful eligible trackers across up to 30 closed eligible days, and does not include the still-open current day. Period activity and tracker statistics link back to Analytics.

## Local storage and cloud synchronization

The browser saves workspace data locally first. When signed in and online, queued tracker, entry, and holiday changes synchronize with Supabase. Revision tracking detects when a cloud record has changed since the local device last read it. The app preserves both sides in a sync conflict instead of silently overwriting one version.

Tracker sync checks stable measure IDs and historical interpretation. A remote edit that changes the type of a saved measure or the meaning of a measure with recorded history becomes a conflict. Resolve it through the app’s conflict flow before making dependent edits or deleting the tracker. Offline changes remain queued locally until sync can proceed.

The sync engine verifies account ownership and rechecks the active account while applying pages of remote data. It does not merge records owned by another account. If sync is pending, failed, or conflicted, check the connection and sync status, then resolve the listed conflict. Do not delete local data to “fix” a conflict; that can remove the preserved local version.

Workspace appearance and time-zone preferences are local settings and do not currently synchronize. Date-only check-ins remain on their original dates when the time zone changes; future date interpretation uses the selected zone.

## Examples and common questions

- **“Why does the old measure still appear in History?”** Retirement preserves the definition so earlier entries keep their original label and unit.
- **“Why is there no old value in Analytics?”** Check whether the selected date period includes it, whether the measure had a value on that date, and whether the entry is the latest live revision.
- **“Why did an edit not overwrite the other device?”** The remote revision changed; the app records a conflict so the two definitions can be reviewed.
- **“Why does All Trackers not show one combined number?”** Different measures may use different units, so trends and values remain separated by measure.

Source references: `src/features/history/HistoryPage.tsx`, `src/features/history/HistoryPage.test.tsx`, `src/domain/trackers/analytics.ts`, `src/domain/trackers/analytics.test.ts`, `src/domain/trackers/activityHeatmap.ts`, `src/services/supabase/syncEngine.ts`, `src/services/supabase/syncEngine.test.ts`, `src/db/syncConflictRepository.ts`, `src/db/localRepository.ts`, `src/db/database.ts`, `src/features/settings/WorkspaceTimeZone.tsx`.
