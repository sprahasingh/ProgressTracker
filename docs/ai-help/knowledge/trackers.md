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
Trackers deleted through the tracker flow appear in The Bin, where you can choose Restore. A signed-in account restore may remain under server verification; while it is pending, the tracker is unavailable for tracking and remains visible in The Bin with its activity and planning data preserved. Once the server confirms restoration, the tracker returns to its prior active or archived state. Archiving or pausing a tracker is different: it stays in your tracker library and keeps its history.

### ID: bin-retention
**Category:** trackers
**Question:** What happens to a tracker after I delete it?
**Aliases:**
- Is a deleted tracker erased immediately?
- How long can I restore something from The Bin?
**Keywords:** delete, Bin, soft delete, restore, retention, permanent deletion
**Suggestible:** false
**Sources:**
- src/features/trackers/TrackerBinPage.tsx
- src/db/localRepository.ts
- supabase/migrations/20261101000100_schedule_tracker_bin_cleanup.sql
- supabase/migrations/20261104002100_reconcile_delete_wins_progression.sql
- supabase/migrations/20261104002200_preserve_deleted_tracker_reward_context.sql
**Answer:**
Deleting a tracker moves it to The Bin, where it can be restored for 30 days with its saved progress and plan. Permanent deletion requires server confirmation and offers two choices. Keep my Wins history deletes tracker and activity data but retains the complete confirmed Wins record: XP (including reconstructed XP), the level derived from it, unlocked badges and their dates and repeatable awards, milestone rewards, and achievement progress. For source-linked rewards, Wins also retains the recorded tracker name and reward reason, plus the reward date and amount. When a stored tracker source has only a generic name, Wins says “Tracker name unavailable.” Older deletion history whose source details were already erased cannot be reconstructed and remains generic. Notes, metrics, activity records, tracker IDs, and entry IDs are not retained in the historical context. Shared account-level rewards remain shared. Deleted activity cannot earn future rewards. Delete tracker and its Wins history reverses only exact tracker-linked rewards; the server refuses this choice without changing data if reconstructed XP, shared or goal rewards, achievement history, or unattributed XP prevents safe reconciliation. If scheduled cleanup is configured, it uses Keep my Wins history. The cleanup switch remains off until its schedule and database safeguards have been verified.

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
**Answer:**
Some edits can change which dates count in schedule-based statistics, because calculations use the tracker’s current schedule and active period. A saved measure’s type and historical interpretation are protected. Retiring a measure removes it from future check-ins while retaining its definition for old entries.

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
The schedule defines the regular days when a tracker has a check-in opportunity. You choose it while creating or editing a tracker. Standard Mode uses those scheduled dates for streak and consistency opportunities; Strict Mode treats every active date as an opportunity.

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
The tracker’s active period is bounded by its start date and, when set, its deadline. Dates outside that period are not active tracking opportunities. A deadline therefore stops schedule-based calculations from counting later dates.

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
Retiring a measure removes it from future check-ins while keeping its definition available to interpret older entries. That is why an old measure may still appear when you review historical data.

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
Open Trackers, choose the tracker’s edit action, update its supported settings, then save. You can change configuration such as its schedule and add measures, while saved measure types and their historical meaning are protected.

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
No. The effective active period starts on the later of the configured start date and the tracker’s creation date in the workspace time zone. Earlier dates are outside the tracker’s active period.

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
