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
**Answer:**
Moving a tracker to the Bin keeps its saved progress and rewards. You can restore it while it is in the Bin. Permanently Delete cannot be undone. Choose Keep My Wins to remove the tracker and its activity while preserving earned XP, badges, achievements, reward history, and appropriate tracker context. Choose Delete Tracker and Wins to remove the tracker and its activity and reverse only rewards linked to it. Other rewards and achievements stay. If rewards cannot be safely separated, nothing is deleted; choose Keep My Wins instead.

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
Rule and schedule edits recalculate derived history using the current tracker settings, so historical success, streaks, and progress can change while saved activity values remain intact. A saved measure’s type and historical meaning are protected; checklist item definitions also stay fixed after history exists. Custom fields with saved values keep their label and interpretation. Retire a measure or field to stop collecting future values while retaining its definition for old entries.

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
New trackers start with Daily recurrence. You can choose Weekdays, Weekends, any non-empty Custom Days combination (including Saturday only or Sunday only), or No Recurrence. In Standard Mode, No Recurrence creates no mandatory or missed check-in days, but you can still record flexible progress from the tracker library or Calendar. The selected recurrence controls Standard Mode expected dates, consistency, and Goal Auto planning; Strict Mode remains an independent streak policy that treats every active date as a streak opportunity. Calendar Days stays fixed. Effective Days can count recurrence-matching activity dates or all non-holiday dates; existing records without a method retain the latter behavior.

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
The tracker’s active period begins on its configured start date, or its creation date in the workspace time zone when no start date is set, and ends at its deadline when one is set. A configured start date can be before tracker creation, allowing eligible past activity to be recorded. Dates outside the active period are not tracking opportunities; a deadline stops schedule-based calculations from counting later dates.

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
Calendar Days uses the deadline you choose, and holidays or rest days do not move it. Effective Days asks for a number of counted dates and projects the deadline using the selected counting method. New scheduled trackers can count only recurrence-matching activity dates, or include every non-holiday calendar date. Existing records without a saved method keep the previous behavior of counting every date except holidays explicitly marked in ProgressTracker's calendar. Public holidays, festivals, and missed check-ins do not change eligibility; missed check-ins still consume any eligible Effective Day. Ongoing has no fixed deadline. These duration counts are separate from activity schedules, completed check-ins, and streaks.

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
Retiring a measure removes it from future check-ins while keeping its definition available to interpret older entries. Resolve any success-rule, streak-rule, goal-plan, or milestone dependency first. That is why an old measure may still appear when you review historical data.

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
Open Trackers, choose the tracker’s edit action, update its supported settings, then save. Rule and schedule edits recalculate derived history under the current configuration, while saved activity values remain intact. Saved measure definitions and custom-field meanings are protected; retire one and add a replacement to change how future check-ins are recorded.

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
