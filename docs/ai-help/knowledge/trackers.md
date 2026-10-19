# Trackers

### ID: restore-deleted-tracker
**Category:** trackers
**Question:** Can I restore a deleted tracker?
**Aliases:**
- Where do deleted trackers go?
- How do I recover a tracker from the Bin?
**Keywords:** Bin, restore, deleted tracker, archive, recover
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerBinPage.tsx
- src/features/trackers/TrackerLibraryPage.tsx
- src/features/trackers/TrackerBinPage.test.tsx
**Answer:**
Move a tracker to the Bin to keep its saved progress and plan. Choose Restore to use it again. If a restore is still in progress, the tracker stays unavailable until it finishes. Archiving is different: an archived tracker stays in your library with its history.

### ID: bin-retention
**Category:** trackers
**Question:** What happens to a tracker after I delete it?
**Aliases:**
- Is a deleted tracker erased immediately?
- How long can I restore something from The Bin?
**Keywords:** Move to Bin, Bin, Restore, Permanently Delete, Keep My Wins, Delete Tracker and Wins
**Suggestible:** false
**Sources:**
- src/features/trackers/TrackerBinPage.tsx
- src/db/localRepository.ts
- src/services/supabase/syncEngine.ts
**Answer:**
Moving a tracker to the Bin keeps its saved progress and rewards. You can restore it while it is in the Bin. Permanently Delete cannot be undone. The confirmation explains that unsynced changes and tracker-owned history may be lost. Choose Keep My Wins to remove the tracker and its activity while preserving earned XP, badges, achievements, reward history, and appropriate tracker context. Choose Delete Tracker and Wins to remove the tracker and its activity and reverse only rewards linked to it. Other rewards and achievements stay. If rewards cannot be safely separated, the server rejects that selected policy and nothing is deleted. After confirmation, deletion is saved locally even when offline, and its Wins choice stays attached to the request while it is pending. If the server definitively rejects Delete Tracker and Wins because reward attribution is incomplete, the Bin offers an explicit confirmation to create a new Keep My Wins request; an uncertain or in-flight request cannot be changed. Pending tracker configuration and check-in operations are superseded so they cannot replay. Once online, the app fetches a fresh cloud revision and asks the owner-checked deletion RPC to delete the tracker atomically. Sync conflicts do not require repair first. The tracker is hidden locally while deletion is pending; local content and conflict UI are cleared only after the server confirms deletion. A durable server deletion ledger blocks stale writes from older versions and other devices from recreating the tracker.

### ID: edit-tracker-history
**Category:** trackers
**Question:** Do tracker edits change historical statistics?
**Aliases:**
- What happens to old stats when I edit a tracker?
- Can changing a measure change old entries?
**Keywords:** edit, historical, measure type, schedule, statistics
**Suggestible:** true
**Sources:**
- src/domain/trackers/invariants.ts
- src/features/trackers/TrackerConfigurationEditor.tsx
- src/domain/trackers/analytics.ts
- src/domain/trackers/ruleVersions.ts
- src/domain/trackers/progression.ts
- src/domain/trackers/types.ts
- src/db/localRepository.ts
- src/domain/trackers/historicalDependencies.ts
- supabase/migrations/20261117000100_versioned_tracker_evaluation_rules_v10.sql
- supabase/migrations/20261119000100_tracker_edit_sync_guards.sql
**Answer:**
Rule and schedule edits can change derived success, streaks, and progress, but saved check-in values, notes, dates, and identities remain intact. Versioned trackers evaluate each date with the rule settings saved for that date. An existing measure’s type is immutable even when no check-in is visible locally; its stable ID must keep the same cloud and historical meaning. Checklist item definitions also stay fixed after history exists. All-history recalculation also checks every measure referenced by success or streak rules, goal plans, and measure milestones against each date-effective snapshot. If a measure was unavailable, retired, reactivated after a gap, changed meaning, or its historical definition cannot be proven, all-history recalculation is unavailable. Legacy trackers without date-effective snapshots cannot prove that history. Custom-field definitions on existing trackers cannot currently be added, removed, retired, reactivated, or semantically changed because their historical availability is not date-versioned. Existing custom-field values remain preserved, and position-only ordering changes are allowed.

### ID: tracker-rule-history-choices
**Category:** trackers
**Question:** How does changing a tracker rule affect my past progress?
**Aliases:**
- What does Apply from today mean?
- What happens if I recalculate all history?
- Will editing a rule change my saved check-ins?
**Keywords:** tracker rule, historical rules, Apply from today, recalculate history, streak, XP
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerSetupPage.tsx
- src/domain/trackers/historicalDependencies.ts
- src/domain/trackers/ruleVersions.ts
- src/domain/trackers/types.ts
- src/domain/trackers/progression.ts
- supabase/migrations/20261117000100_versioned_tracker_evaluation_rules_v10.sql
- supabase/migrations/20261119000100_tracker_edit_sync_guards.sql
**Answer:**
For supported evaluation or measure edits on an existing tracker, choose **Apply from today**, **After the last check-in**, or **Apply to all history**. The displayed effective date uses the workspace time zone. Earlier dates retain their saved rule snapshots for forward-only edits; a check-in is evaluated using the configuration effective on its date. Structural measure changes cannot apply to all history, and Apply from today is unavailable when a same-day check-in would be reinterpreted; choose After the last check-in to start the day after the latest saved entry. If two choices resolve to the same date, they have the same effect. Apply to all history is offered only when v10 snapshots cover the full period, required inputs and reconciliation are available, and every measure referenced by the success rule, streak rule, goal plan, or measure milestone was available with the same meaning throughout that period. It is also unavailable when past successful-day or streak rewards could change. If those dependencies or their history cannot be proven, the option is disabled with a reason. Deferred changes require confirmation. Existing check-in values, notes, dates, and IDs are preserved. Milestone requirement edits and existing goal plan edits are currently blocked because their historical requirements are not versioned. Cosmetic edits do not ask for a history policy.

### ID: archive-tracker
**Category:** trackers
**Question:** What happens when I archive a tracker?
**Aliases:**
- Does archiving delete my tracker history?
- Can I restore a paused tracker?
**Keywords:** archive, pause, active, history, delete
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerLibraryPage.tsx
- src/features/trackers/TrackerBinPage.tsx
**Answer:**
Archiving a tracker removes it from Today and current activity while keeping its recorded history and rewards. The tracker list can show active, archived, or all trackers. When editing an archived tracker, choose whether to keep it archived or move it to active after saving. Deleting a tracker is a separate action that moves it through the app’s Bin and restore flow.

### ID: tracker-schedules
**Category:** trackers
**Question:** How do tracker schedules work?
**Aliases:**
- Which days count as scheduled?
- How do I choose tracking days?
**Keywords:** schedule, weekly, daily, weekdays, opportunity
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/features/trackers/TrackerSetupPage.tsx
**Answer:**
New trackers start with Daily recurrence. You can choose Weekdays, Weekends, any non-empty Custom Days combination (including Saturday only or Sunday only), or No Recurrence. In Standard Mode, No Recurrence creates no mandatory or missed check-in days, but you can still record flexible progress from the tracker library or Calendar. The selected recurrence controls Standard Mode expected dates, consistency, and Goal Auto planning; Strict Mode treats every active date as a streak opportunity. Calendar Days stays fixed. Effective Days can count recurrence-matching activity dates or all non-holiday dates; existing records without a method retain the latter behavior. Editing a schedule on an existing tracker uses the three history choices when evaluation changes; Apply to all history is unavailable for schedule changes unless compatibility is proven, and the exact effective date is shown before confirmation.

### ID: start-date-deadline
**Category:** trackers
**Question:** How do a tracker’s start date and deadline affect it?
**Aliases:**
- When does a tracker begin counting?
- Does a deadline stop future check-ins?
**Keywords:** start date, deadline, active period, schedule, tracker
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/domain/trackers/activePeriod.test.ts
- src/domain/trackers/planning.test.ts
- src/features/trackers/TrackerSetupPage.tsx
**Answer:**
The tracker’s active period begins on its configured start date, or its creation date in the workspace time zone when no start date is set, and ends at its deadline when one is set. A configured start date can be before tracker creation, allowing eligible past activity to be recorded. Dates outside the active period are not tracking opportunities; a deadline stops schedule-based calculations from counting later dates. An existing tracker’s start date or deadline change uses the history policy choices, but Apply to all history is disabled unless compatibility is proven. The editor shows the effective date and requires confirmation for a deferred change. Saved check-ins outside the resulting active period stay in History but do not count as opportunities.

### ID: tracker-duration-modes
**Category:** trackers
**Question:** What is the difference between Calendar Days, Effective Days, and Ongoing?
**Aliases:**
- How does an Effective Days deadline work?
- Do holidays change my tracker deadline?
**Keywords:** Calendar Days, Effective Days, Ongoing, deadline, holiday, rest day, duration
**Suggestible:** true
**Sources:**
- src/domain/trackers/scheduling.ts
- src/features/trackers/TrackerSetupPage.tsx
- src/domain/trackers/challengeDay.ts
**Answer:**
Calendar Days uses the deadline you choose, and holidays or rest days do not move it. Effective Days asks for a number of counted dates and projects the deadline using the selected counting method. New scheduled trackers can count only recurrence-matching activity dates, or include every non-holiday calendar date. Existing records without a saved method keep the previous behavior of counting every date except holidays explicitly marked in ProgressTracker's calendar. Public holidays, festivals, and missed check-ins do not change eligibility; missed check-ins still consume any eligible Effective Day. Ongoing has no fixed deadline. These duration counts are separate from activity schedules, completed check-ins, and streaks. Editing an existing tracker’s duration or scheduling settings uses the three history choices; Apply to all history is disabled unless historical compatibility is proven.

### ID: retire-measure
**Category:** trackers
**Question:** What happens when I retire a measure?
**Aliases:**
- Can I remove a measure but keep its history?
- Why is an old measure still shown in History?
**Keywords:** retire, measure, old entries, history, future check-ins
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerConfigurationEditor.tsx
- src/domain/trackers/types.ts
- src/domain/trackers/schema.test.ts
- src/features/history/HistoryPage.tsx
**Answer:**
Retiring a measure removes it from future check-ins while keeping its definition available to interpret older entries. Resolve any success-rule, streak-rule, goal-plan, or milestone dependency first. Measure edits use a date-effective history choice; structural changes cannot apply to all history, and cannot start today if a check-in already exists today. The editor offers After the last check-in in that case. That is why an old measure may still appear when you review historical data.

### ID: tracker-editing
**Category:** trackers
**Question:** How do I edit a tracker?
**Aliases:**
- Where can I change a tracker’s schedule?
- Can I add another measure to a tracker?
**Keywords:** edit, tracker, schedule, measures, configuration
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerLibraryPage.tsx
- src/features/trackers/TrackerConfigurationEditor.tsx
- src/features/trackers/TrackerSetupPage.tsx
- src/features/trackers/TrackerSetupPage.test.tsx
**Answer:**
Open Trackers, choose the tracker’s edit action, update its supported settings, then save. Supported rule or measure changes offer **Apply from today**, **After the last check-in**, and **Apply to all history**, with an exact effective date in the workspace time zone. Structural measure changes cannot apply to all history, and Apply from today is disabled when today’s check-in would be reinterpreted. Apply to all history is enabled only when compatibility and required historical inputs are proven. Deferred changes require confirmation; check-ins are never deleted automatically. Milestone requirement edits and existing goal plan edits are blocked until their history can be preserved safely. A rename, description, or other cosmetic edit does not show the choice. Saved check-ins remain intact, and an existing measure’s type cannot be changed.

### ID: tracker-created-active-date
**Category:** trackers
**Question:** Does a tracker count dates before I created it?
**Aliases:**
- Does its start date include days before the tracker existed?
- Why does a tracker created today start counting today?
**Keywords:** tracker creation date, start date, active period, workspace time zone
**Suggestible:** true
**Sources:**
- src/domain/trackers/planning.ts
- src/domain/trackers/activePeriod.test.ts
**Answer:**
Yes, when you set a start date before creating the tracker. Eligible dates from that configured start through today can be recorded and edited; missing dates stay empty until you add a check-in. Without an explicit start date, the active period begins on the tracker’s creation date in the workspace time zone. Schedule, deadline, and archived status still apply.

### ID: archived-checkin-history
**Category:** trackers
**Question:** Can I edit check-ins after archiving a tracker?
**Aliases:**
- Is archived tracker history read-only?
- Does archiving keep old entries but stop edits?
**Keywords:** archived tracker, check-in, history, read-only, archive
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/features/trackers/TrackerLibraryPage.tsx
**Answer:**
Archiving keeps the tracker’s saved history, but its check-ins are read-only while the tracker is archived. Restore it to active status if you need to edit its check-ins again.
