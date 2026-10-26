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
Open Holidays & breaks and choose **All trackers** for a global holiday or **Selected trackers** to choose one or more eligible Standard Mode trackers. The same form edits either scope; tracker-specific selections are not managed on a separate tracker page. You can choose past dates. Holidays remain separate from check-ins and synchronize across devices when signed in.

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
Removing a global holiday moves it to Recently deleted holidays, where it can be restored for 30 days; selected holidays can be edited or removed from their selected tracker set. These changes recalculate affected progression while preserving saved check-ins and append-only award history. When permanent deletion is enabled, a global holiday can also be permanently deleted through its menu.

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
In Holidays & breaks, **All trackers** creates a global holiday and **Selected trackers** applies it only to the chosen Standard Mode trackers. Global holidays are stored independently and new trackers receive them automatically, though only Standard Mode requirements are excused; Strict Mode keeps its normal requirements. Selected holidays do not affect other trackers. Positive work overrides the holiday for that tracker and date; clearing the work restores the exemption.

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
Removing or changing a holiday makes affected dates and tracker scopes subject to the updated holiday and schedule rules. Daily XP, milestones, Perfect Days, and dependent achievements are reconciled for affected history when the server receives the change; reversals remain in award history. Saved check-ins are preserved, and positive work remains eligible under the rules for its date.

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
Yes. A holiday is an expectation exemption, not a restriction on work. Positive progress overrides it for that tracker and date and is evaluated under that date’s applicable rules; eligible rewards are reconciled when the signed-in change synchronizes. Zero and Skip leave the holiday effective. Strict Mode continues its normal requirements through global holidays.

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
Open Holidays & breaks, choose **Selected trackers**, then select one or more eligible Standard Mode trackers. Strict Mode trackers are omitted and cannot receive exemptions. Positive progress overrides the selected holiday for that tracker/date; clearing it restores the holiday. Changes sync with the account when online.

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
Calendar aggregates each tracker’s effective status. It shows Holiday only when all applicable trackers are effectively on holiday. Otherwise it reflects the actual tracker outcomes, including recorded work and Strict Mode requirements. Selected-day details retain holiday information alongside saved work and each tracker’s status.
