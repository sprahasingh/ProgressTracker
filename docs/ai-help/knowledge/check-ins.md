# Daily check-ins

### ID: skipped-vs-unchecked
**Category:** check-ins
**Question:** What is the difference between a skipped and unchecked day?
**Aliases:**
- Is skipping the same as leaving a day blank?
- What does an unchecked date mean?
- What is the difference between skipped and not checked?
**Keywords:** skipped, unchecked, absent, missing check-in, outcome
**Suggestible:** true
**Sources:**
- src/domain/trackers/missingCheckIns.ts
- src/domain/trackers/types.ts
- src/features/history/HistoryPage.tsx
**Answer:**
A skipped day is an explicitly saved check-in marked as skipped. An unchecked date has no saved check-in. History can identify past missing opportunities from their schedule; a skipped entry is already a saved record and is not missing.

### ID: edit-past-checkin
**Category:** check-ins
**Question:** Can I edit a past check-in?
**Aliases:**
- Can I change yesterday’s progress?
- How do I correct an old entry?
**Keywords:** history, edit, past date, check-in, values
**Suggestible:** true
**Sources:**
- src/features/history/HistoryPage.tsx
- src/domain/trackers/progression.ts
**Answer:**
Yes. Open History, select the saved date and tracker entry, then edit its values. The latest saved revision for that date is used in current calculations.

### ID: clear-checkin
**Category:** check-ins
**Question:** What happens if I clear a check-in?
**Aliases:**
- Can I undo a check-in?
- What happens if I clear yesterday’s progress?
**Keywords:** clear, delete, history, missing, re-record, check-in
**Suggestible:** true
**Sources:**
- src/features/shared/ClearCheckInAction.tsx
- src/db/localRepository.ts
- src/domain/trackers/missingCheckIns.ts
**Answer:**
Clearing removes the saved check-in from current progress calculations. If that date was a past opportunity, it can then appear in missing check-in review. You can record the date again by creating a new check-in.

### ID: numeric-zero-vs-empty
**Category:** check-ins
**Question:** Is entering zero different from leaving a number blank?
**Aliases:**
- Does zero count as no progress?
- Is a blank quantity treated as zero?
**Keywords:** quantity, zero, blank, observation, numeric
**Suggestible:** true
**Sources:**
- src/domain/trackers/analytics.ts
- src/features/shared/TrackerEntryFields.tsx
- src/domain/trackers/schema.ts
**Answer:**
Yes. Zero is a recorded numeric value and can be included in observations. A blank field is not a numeric observation. Whether a recorded zero qualifies as a successful check-in depends on the tracker’s success rules.

### ID: mark-missed
**Category:** check-ins
**Question:** What happens when I mark a check-in as missed?
**Aliases:**
- Is marking a day missed different from leaving it blank?
- Does Mark as missed break my streak?
**Keywords:** mark as missed, skipped, outcome, unchecked, streak
**Suggestible:** true
**Sources:**
- src/domain/trackers/types.ts
- src/domain/trackers/progression.ts
- src/features/today/TodayPage.tsx
**Answer:**
Mark as missed saves an intentional skipped outcome for that date, and it breaks the streak. Leaving a date unchecked creates no saved entry; a past date can then appear in missing check-in review if it was an opportunity.

### ID: custom-checkin-fields
**Category:** check-ins
**Question:** What are custom check-in fields?
**Aliases:**
- Can I add a note to a check-in?
- Do notes count toward goal progress?
**Keywords:** notes, custom fields, context, measure, goal progress
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerConfigurationEditor.tsx
- src/features/shared/TrackerEntryFields.tsx
- src/domain/trackers/types.ts
- src/features/shared/TrackerEntryFields.test.tsx
**Answer:**
Custom check-in fields add context to an entry, such as a note or selected answer. They are separate from tracker measures and are not used as numeric goal totals.

### ID: checkin-types
**Category:** check-ins
**Question:** What kinds of values can I record in a tracker?
**Aliases:**
- Can I track a number or a yes/no habit?
- What measure types are available?
**Keywords:** Yes/No, quantity, measures, recorded values, legacy
**Suggestible:** true
**Sources:**
- src/domain/trackers/types.ts
- src/features/trackers/trackerSetupSchema.ts
- src/features/shared/TrackerEntryFields.tsx
**Answer:**
New tracker measures use Yes/No or Quantity values. Existing trackers may also contain legacy measure types such as Duration or Checklist, which remain supported for their saved history.
