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
- supabase/migrations/20261126000100_tracker_history_precision_dependencies.sql
**Answer:**
Threshold values and direction can be edited after a measure has history. They change derived classifications, while the saved check-in values, notes, dates, and identities remain intact. Versioned trackers evaluate each date with the rule settings saved for that date. An existing measure’s identity, type, unit, and checklist item definitions stay fixed after history exists. Numeric precision can change prospectively through a confirmed effective date; saved values are never rounded. All-history recalculation requires complete date-effective snapshots, matching precision for each affected measure across every historical snapshot, and a saved value for each active measure in the proposed definition on every recorded check-in. A retired measure does not need a value solely because it remains in an older definition; an unverifiable historical rule or milestone dependency still blocks recalculation. If a required measure was unavailable, reactivated after a gap, changed meaning or precision, or its historical definition cannot be proven, all-history recalculation is unavailable. Legacy trackers without date-effective snapshots cannot prove that history. Custom-field definitions on existing trackers cannot currently be added, removed, retired, reactivated, or semantically changed because their historical availability is not date-versioned. Existing custom-field values remain preserved, and position-only ordering changes are allowed.

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
- supabase/migrations/20261126000100_tracker_history_precision_dependencies.sql
**Answer:**
Threshold edits on an existing measure with saved check-ins offer **Apply from today**, **After the last check-in**, or **Apply to all history**. The displayed effective date uses the workspace time zone. Forward-only edits preserve earlier evaluations; Apply from today starts today, and After the last check-in starts the day after the latest saved entry. Apply to all history reevaluates saved entries with the new thresholds and reconciles affected XP, streak and goal milestone rewards, Perfect Day, and achievements through the existing reversal and restoration history. Its confirmation explains that derived progression can change while recorded values and notes remain intact. Apply from today is unavailable when a future-dated entry exists; all-history recalculation is also unavailable while future-dated entries exist, so choose After the last check-in to keep the new rules after them. All-history recalculation requires v10 snapshots covering the full period, matching precision for each affected measure across those snapshots, a value for each proposed active measure on every recorded check-in, and proof that historical rule dependencies kept the same identity and meaning. Retired measures do not need saved values solely because they remain in an older definition. A precision change can use a confirmed forward effective date; it does not round or rewrite earlier check-ins. Structural or schedule and boundary changes cannot apply to all history. Changes can be saved locally while offline; cloud upload waits for the threshold-aware sync guard and a server revision check, and a rejected or conflicting payload remains available for recovery. Milestone requirement edits and existing goal plan edits remain blocked because their historical requirements are not versioned. Cosmetic edits do not ask for a history policy.

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
Archiving a tracker removes it from Today while keeping its recorded history and rewards. The archive date itself remains eligible; later dates are inactive for progression. Existing awards after that date are reconciled through a bounded background queue, and unarchiving can restore eligible awards using the existing append-only reversal and restoration history. The current data model stores one archive date, so it cannot reconstruct earlier archive/unarchive intervals. The tracker list can show active, archived, or all trackers. Deleting a tracker is a separate action that uses the Bin and restore flow.

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
Open Trackers, choose the tracker’s edit action, update its supported settings, then save. Supported rule or threshold changes offer **Apply from today**, **After the last check-in**, and **Apply to all history**, with an exact effective date in the workspace time zone. Apply from today can change today’s evaluation; it is disabled for structural changes when today’s check-in would be reinterpreted and whenever a future-dated check-in exists. After the last check-in starts on the day after the latest saved entry. Apply to all history is enabled only when compatibility and required historical inputs are proven, including matching numeric precision across the historical snapshots. Structural measure changes cannot apply to all history. Numeric precision can change prospectively through a confirmed effective date without rewriting saved values. Deferred changes require confirmation; check-ins are never deleted automatically. Threshold changes can be saved locally while offline and remain queued until the threshold-aware server guard and revision check are available. Milestone requirement edits and existing goal plan edits are blocked until their history can be preserved safely. A rename, description, or other cosmetic edit does not show the choice. Saved check-in values remain intact, and an existing measure’s type cannot be changed.

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
Archiving keeps the tracker’s saved history, but its check-ins are read-only while it is archived. Restore it to active status if you need to edit them. Its archive date remains within its active progression period; dates after that boundary are inactive, while the original saved entries remain visible in History.
