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
