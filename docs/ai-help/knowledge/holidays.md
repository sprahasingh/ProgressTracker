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
- supabase/migrations/20261124000100_holiday_checkin_treatment.sql
**Answer:**
In Standard Mode, each holiday check-in has an explicit treatment. **Keep as Holiday** (the default for new holiday check-ins) saves the activity while leaving the date neutral for progression, even if the measurement reaches its target. **Count as Normal Check-in** makes the date a regular scheduled opportunity, so the saved values are evaluated by the usual success and streak rules; zero can therefore count as a failed opportunity. Older entries without a saved choice retain their previous behavior: positive work counts normally, while zero, Skip, or no entry leaves the holiday effective. Strict Mode requirements are unchanged. Goal plans retain their existing account-wide holiday rules.

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
In Holidays & breaks, **All trackers** creates a global holiday and **Selected trackers** applies it only to the chosen Standard Mode trackers. Global holidays are stored independently and new trackers receive them automatically, though only Standard Mode requirements are excused; Strict Mode keeps its normal requirements. Selected holidays do not affect other trackers. For each Standard Mode holiday check-in, choose **Keep as Holiday** to save activity without making the date a progression opportunity, or **Count as Normal Check-in** to apply regular rules. Clearing the entry restores the holiday state.

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
Removing or changing a holiday makes affected dates and tracker scopes subject to the updated holiday and schedule rules. Daily XP, milestones, Perfect Days, and dependent achievements are reconciled for affected history when the server receives the change; reversals remain in award history. Saved check-ins and their treatment choices are preserved. While the holiday applies, **Keep as Holiday** stays neutral even with positive values; **Count as Normal Check-in** follows normal date-effective rules. Removing the holiday makes the date follow the usual schedule rules.

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
- supabase/migrations/20261124000100_holiday_checkin_treatment.sql
**Answer:**
Yes. On a Standard Mode holiday, choose **Keep as Holiday** to save the activity while preserving the exemption, or **Count as Normal Check-in** to evaluate the entry under its date-effective rules. The second choice also makes zero a normal opportunity. Strict Mode uses its normal requirements and does not show this choice. Existing entries without an explicit choice keep their legacy behavior: positive progress counts normally; zero and Skip leave the holiday effective. Progression changes reconcile when the signed-in change synchronizes.

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
Strict Mode treats every date in the tracker’s active period as an opportunity, including account-wide holidays; the holiday treatment choice is not available. Without a qualifying check-in, an elapsed holiday can break the streak. Standard Mode holidays are neutral by default, while **Count as Normal Check-in** makes that date an ordinary opportunity.

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
- supabase/migrations/20261124000100_holiday_checkin_treatment.sql
**Answer:**
Open Holidays & breaks, choose **Selected trackers**, then select one or more eligible Standard Mode trackers. Strict Mode trackers are omitted and cannot receive exemptions. On a selected holiday, choose **Keep as Holiday** to save work while keeping the date neutral, or **Count as Normal Check-in** to apply normal scheduled rules. Clearing the check-in restores the holiday treatment. Changes sync with the account when online.

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
- supabase/migrations/20261124000100_holiday_checkin_treatment.sql
**Answer:**
Holiday records are stored separately from check-ins, and the treatment choice is stored on the check-in. Clearing the entry removes its treatment and restores the holiday exemption. Editing measurements does not change the selected treatment. If an entry is later restored, its saved treatment applies again; deleting the holiday makes the date follow normal schedule rules.

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
Calendar aggregates each tracker’s effective status. It shows Holiday only when all applicable trackers are effectively on holiday. Otherwise it reflects the actual tracker outcomes, including work saved as holiday activity, normal holiday check-ins, and Strict Mode requirements. Selected-day details retain holiday information and saved work together.
