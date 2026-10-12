# History

### ID: history-includes
**Category:** history
**Question:** What does History include?
**Aliases:**
- What can I see in History?
- Why does History not show every date?
- Where can I review saved check-ins?
**Keywords:** saved entries, historical, holidays, missing check-ins, date, values
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/missingCheckIns.ts
- src/features/history/HistoryPage.test.tsx
**Answer:**
History shows saved check-ins and their recorded values for past dates, along with workspace holidays in the selected date range. It also offers a missing check-in review for unresolved opportunities in the previous seven completed days. Dates that were not tracking opportunities are not shown as missing, and today is not treated as overdue.

### ID: missing-checkins
**Category:** history
**Question:** Where can I find missing check-ins?
**Aliases:**
- How do I review missed days?
- Can I find dates I forgot to log?
- Where do I review missed check-ins?
**Keywords:** missing, overdue, history, schedule, past opportunity
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/missingCheckIns.ts
**Answer:**
Open History and review its missing check-in section. It lists past unresolved opportunities for active trackers, based on each tracker’s active dates, schedule, Strict Mode, and workspace holidays. It does not list today as missing.
