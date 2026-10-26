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
History shows saved check-ins and their recorded values for past dates, along with global holidays in the selected date range. Each saved measure name labels its value; Yes/No values read **Done** or **Not Done**, while the entry outcome is shown separately. Checklist values show checked items. You can open an eligible entry to edit it or choose a tracker and date to add a missing check-in. Historical edits preserve the saved record and recalculate applicable progression and rewards when synchronized. Archived trackers and dates outside the active period remain viewable but may be read-only or ineligible. Missing review covers unresolved opportunities in the previous seven completed days; today is not overdue.

### ID: history-clear-note
**Category:** history
**Question:** Does clearing a check-in remove its note?
**Aliases:**
- Does clearing remove a check-in note?
- What happens to a note when I clear its check-in?
- Is the note kept if I delete an old entry?
**Keywords:** clear check-in, note, history, deleted entry
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/db/localRepository.ts
**Answer:**
The note belongs to the saved check-in, so clearing the check-in removes it from active History along with the entry. Clearing does not provide a separate option to keep the note while removing the check-in.

### ID: history-clear-sync
**Category:** history
**Question:** Is clearing a check-in the same as permanently erasing it everywhere?
**Aliases:**
- Does clearing permanently delete a check-in from storage?
- Is a cleared entry removed from the cloud too?
**Keywords:** clear, permanent deletion, tombstone, sync, history
**Suggestible:** false
**Sources:**
- src/db/localRepository.ts
- src/services/supabase/syncEngine.ts
- src/features/history/HistoryPage.tsx
**Answer:**
Clearing removes the entry from active history on this device and queues a deletion update for account sync when available. The app uses deletion state during synchronization; clearing should not be treated as proof that every stored copy or backup has been permanently erased.

### ID: history-reenter-cleared
**Category:** history
**Question:** Are my old values restored when I check in again after clearing?
**Aliases:**
- Can I undo a cleared check-in by logging again?
- What if I want to add progress on that date after clearing it?
**Keywords:** clear, re-enter, save, check-in, date
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/features/history/HistoryPage.tsx
**Answer:**
No. Clearing removes the entry from active history, so its old values are not filled back into a new check-in. You can save progress for that tracker and date again by entering the values you want to record.

### ID: history-cleared-missing
**Category:** history
**Question:** Why can a cleared date appear as a missing check-in?
**Aliases:**
- Does clearing make an old scheduled day missing?
- Why did History list a date after I removed its entry?
**Keywords:** clear, missing check-in, scheduled opportunity, history
**Suggestible:** true
**Sources:**
- src/domain/trackers/missingCheckIns.ts
- src/features/history/HistoryPage.tsx
**Answer:**
The missing-check-in review looks for past opportunities without an active saved entry. After you clear an entry, a past date can qualify as missing if it is still an active opportunity under that tracker’s schedule, mode, and holiday rules.

### ID: history-clear-streak
**Category:** history
**Question:** Does clearing a check-in affect my streak?
**Aliases:**
- Will deleting a past entry recalculate my streak?
- What happens to a streak after I clear one day?
**Keywords:** clear check-in, streak, recalculation, opportunity
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/progression.ts
**Answer:**
Yes, streaks are calculated from active saved entries that meet the tracker’s Streak Rule, so clearing one can change the current or longest streak. The result depends on whether that date is a counted opportunity under Standard or Strict Mode and the tracker’s schedule and holiday rules.

### ID: history-outside-period
**Category:** history
**Question:** Why does History label an entry as outside the tracker period?
**Aliases:**
- What does Historical mean next to an old check-in?
- Why is my saved entry not counted in current progress?
**Keywords:** History, historical entry, start date, deadline, active period
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/activityStatus.ts
- src/domain/trackers/planning.ts
**Answer:**
The entry was saved on a date outside the tracker’s current active period, which is bounded by its effective start date and deadline. History keeps the entry visible, but it does not count toward current period calculations.

### ID: history-seven-day-review
**Category:** history
**Question:** How far back does History review missing check-ins?
**Aliases:**
- Can History find older missed dates?
- Does the missing section cover the whole tracker history?
**Keywords:** History, missing check-ins, seven days, review window
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/missingCheckIns.ts
**Answer:**
The missing check-in section reviews unresolved opportunities in the previous seven completed days. It is a short review window, not a list of every gap in the tracker’s history; use Calendar to inspect older dates.

### ID: history-cleared-holiday
**Category:** history
**Question:** Can a cleared check-in on a holiday become a missing date?
**Aliases:**
- Will clearing a holiday entry create a missed check-in?
- Does the missing review include holidays after I clear them?
**Keywords:** cleared check-in, holiday, missing, Strict Mode, Standard Mode
**Suggestible:** true
**Sources:**
- src/domain/trackers/missingCheckIns.ts
- src/domain/trackers/planning.ts
- src/domain/trackers/missingCheckIns.test.ts
**Answer:**
In Standard Mode, holidays are excluded from scheduled opportunities, so a cleared holiday entry is not listed as missing. Strict Mode treats every active date, including holidays, as an opportunity; a past cleared holiday can therefore appear in the missing review.

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
