# Holidays and breaks

### ID: create-holiday
**Category:** holidays
**Question:** How do I add a holiday?
**Aliases:**
- Can I mark a day as a break?
- How do I add a retroactive holiday?
**Keywords:** holiday, break, date, reason, workspace
**Suggestible:** true
**Sources:**
- src/features/holidays/HolidaysPage.tsx
- src/domain/holidays.ts
- src/domain/holidays.test.ts
**Answer:**
Open Holidays & breaks to add an account-wide date, or use Tracker-specific holidays to exempt one Standard Mode tracker on a date. Tracker-specific holidays can also be added or removed from the selected date details in Calendar. You can choose past dates; entries remain separate from holiday records and sync across devices when signed in.

### ID: delete-holiday
**Category:** holidays
**Question:** What happens if I delete a holiday?
**Aliases:**
- Does removing a holiday change saved check-ins?
- Can I undo a workspace break?
**Keywords:** holiday, delete, saved check-in, schedule, history
**Suggestible:** true
**Sources:**
- src/features/holidays/HolidaysPage.tsx
- src/domain/holidays.ts
**Answer:**
Deleting a holiday removes that date’s break from future calculations and moves it to Recently deleted holidays, where it can be restored for 30 days. When permanent deletion is enabled for the deployment, you can also confirm that action from the holiday’s three-dot menu. Any check-ins already saved for the date remain saved; deleting the holiday does not erase them.

### ID: holidays-streaks
**Category:** holidays
**Question:** Do holidays count against my streak?
**Aliases:**
- How do holidays affect scheduled check-ins?
- Does a holiday pause my tracker?
- Do holidays count against my streak?
**Keywords:** holiday, streak, scheduled, strict mode, recorded entry
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/planning.ts
- src/domain/holidays.ts
**Answer:**
In Standard Mode, an account-wide or tracker-specific holiday excuses the scheduled opportunity when there is no positive work. Positive progress temporarily overrides the exemption and the entry follows normal success and streak rules; zero and Skip leave the holiday effective. Strict Mode still requires daily activity through account-wide holidays and does not allow tracker-specific holidays. Goal plans retain their existing account-wide holiday rules.

### ID: holiday-all-trackers
**Category:** holidays
**Question:** Do workspace holidays apply to every tracker?
**Aliases:**
- Can I make a holiday for just one tracker?
- Is a holiday shared across my trackers?
**Keywords:** workspace holiday, all trackers, schedule, break
**Suggestible:** true
**Sources:**
- src/domain/holidays.ts
- src/features/holidays/HolidaysPage.tsx
**Answer:**
Account-wide holidays apply across the workspace and continue to affect goal plans. You can also add a tracker-specific holiday for one Standard Mode tracker; it does not affect other trackers or goal plans. Strict Mode trackers cannot receive tracker-specific holidays and remain required on account-wide holidays.

### ID: holiday-remove-recalculates
**Category:** holidays
**Question:** What changes when I remove a holiday?
**Aliases:**
- Does deleting a holiday make that date count again?
- Will removing a holiday change my streak or statistics?
**Keywords:** holiday, remove, schedule, recalculate, streak
**Suggestible:** true
**Sources:**
- src/domain/holidays.ts
- src/domain/trackers/progression.ts
- src/domain/trackers/analytics.ts
**Answer:**
Removing the holiday makes the date subject to the tracker’s usual mode and schedule rules again. Calculated streaks and statistics can therefore change, but saved check-ins are not removed.

### ID: holiday-log-progress
**Category:** holidays
**Question:** Can I record progress on a holiday?
**Aliases:**
- Are check-ins allowed during a workspace break?
- Can I voluntarily log on a holiday?
**Keywords:** holiday, voluntary check-in, saved entry, calendar
**Suggestible:** true
**Sources:**
- src/features/calendar/CalendarPage.tsx
- src/features/today/TodayPage.tsx
- src/domain/trackers/progression.ts
**Answer:**
Yes. A holiday is an expectation exemption, not a restriction on work. Positive progress on a Standard Mode holiday makes the actual Completed or Partial result visible and applies the normal streak, XP, and achievement rules. A zero entry or Skip leaves the holiday effective. Strict Mode continues its normal rules through account-wide holidays.

### ID: holiday-standard-v-strict
**Category:** holidays
**Question:** Why can a holiday be missed in Strict Mode?
**Aliases:**
- Why does Strict Mode still expect a check-in on a holiday?
- Does Strict Mode pause for workspace holidays?
**Keywords:** Strict Mode, holiday, opportunity, missed, streak
**Suggestible:** true
**Sources:**
- src/domain/trackers/progression.ts
- src/domain/trackers/planning.ts
- src/domain/trackers/progression.test.ts
**Answer:**
Strict Mode treats every date in the tracker’s active period as an opportunity, including account-wide holidays. Without a qualifying check-in, an elapsed holiday can break the streak. Standard Mode holidays excuse the opportunity unless positive work is recorded.

### ID: tracker-holiday
**Category:** holidays
**Question:** How do I mark a holiday for one tracker?
**Aliases:**
- Can I skip one tracker on a date?
- How do tracker-specific holidays work?
**Keywords:** tracker holiday, Standard Mode, selected tracker, exemption
**Suggestible:** true
**Sources:**
- src/features/holidays/HolidaysPage.tsx
- src/db/localRepository.ts
- src/domain/trackers/activityStatus.ts
**Answer:**
Open Holidays & breaks, choose a date and a Standard Mode tracker in Tracker-specific holidays, then save. The holiday affects only that tracker and does not change other trackers or goal plans. Strict Mode trackers are excluded.

### ID: holiday-clear-restores
**Category:** holidays
**Question:** What happens to a holiday when I clear a check-in?
**Aliases:**
- Does deleting work restore the holiday?
- If I change progress to zero, does the holiday come back?
**Keywords:** holiday, clear check-in, zero progress, edit, restore
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/features/history/HistoryPage.tsx
- src/features/today/TodayPage.tsx
**Answer:**
Holiday records are stored separately from check-ins. Positive progress temporarily overrides the exemption. Clearing that entry or editing it to zero automatically makes the holiday effective again; zero and Skip do not remove the holiday.

### ID: holiday-calendar-aggregate
**Category:** holidays
**Question:** What does Calendar show when a holiday and tracker activity share a date?
**Aliases:**
- Does a holiday hide completed tracker work?
- Why does a holiday date show Completed or Missed?
**Keywords:** holiday, calendar, aggregate, completed, mixed trackers
**Suggestible:** true
**Sources:**
- src/domain/trackers/dailyActivityStatus.ts
- src/features/calendar/CalendarPage.tsx
**Answer:**
Calendar aggregates each tracker’s effective status. It shows Holiday only when every applicable tracker is effectively on holiday. Completed, Partial, No progress, Skipped, or Missed activity appears when a tracker contributes that outcome; Strict Mode misses therefore remain visible on account-wide holidays. The selected date details still identify the account-wide holiday and each tracker’s status.
