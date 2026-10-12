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
Open Holidays & breaks, choose a date, and save the holiday. You can add a reason and choose a past date; holidays apply across the workspace rather than to only one tracker.

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
Deleting a holiday removes that date’s break from future calculations. Any check-ins already saved for the date remain saved; changing the holiday does not erase them.

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
In Standard Mode, a holiday removes that date from scheduled streak opportunities. In Strict Mode, dates remain daily opportunities, so a holiday by itself does not excuse a missed day. A saved qualifying check-in on a holiday still counts in Strict Mode.

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
Yes. Holidays are workspace-wide dates, not tracker-specific settings. Their effect on opportunities still depends on each tracker’s mode: Standard Mode pauses scheduled opportunities, while Strict Mode counts every active date.

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
Yes. A holiday does not prevent a check-in from being saved. Calendar offers a voluntary check-in on a holiday, and the saved entry remains visible; whether it qualifies for a streak depends on the tracker’s mode and success rule.

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
Strict Mode treats every date in the tracker’s active period as an opportunity, including holidays. Without a qualifying check-in, an elapsed holiday can break the streak. Standard Mode excludes holidays from scheduled opportunities.
