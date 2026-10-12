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
A skipped day is an explicitly saved check-in marked as skipped. An unchecked past date has no saved entry and is shown as Missed only if it was a required opportunity. A saved recorded check-in that fails its success rule remains distinct: it appears as Partial when it has positive progress, or No progress when it does not. Missed is derived and is never saved automatically.

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
**Question:** What happens when I mark a check-in as skipped?
**Aliases:**
- Is marking a day missed different from leaving it blank?
- Does Mark as skipped break my streak?
**Keywords:** mark as skipped, skipped, outcome, unchecked, streak
**Suggestible:** true
**Sources:**
- src/domain/trackers/types.ts
- src/domain/trackers/progression.ts
- src/features/today/TodayPage.tsx
**Answer:**
Mark as skipped saves an intentional skipped outcome for that date. It is not the same as a derived Missed date or a saved No progress result. On a required opportunity, it does not qualify for a streak. Leaving a date unchecked creates no saved entry; after a required date elapses, it can appear as Missed.

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

### ID: checkin-empty-versus-zero-status
**Category:** check-ins
**Question:** Why can a saved zero show no progress instead of a missed day?
**Aliases:**
- Is a zero entry treated as unchecked?
- How does Calendar distinguish zero from no check-in?
**Keywords:** zero, no progress, missed, saved entry, activity status
**Suggestible:** true
**Sources:**
- src/domain/trackers/activityStatus.ts
- src/features/calendar/CalendarPage.tsx
**Answer:**
A saved zero is still a check-in, not a missed day. Calendar evaluates it against the tracker’s success rule and may show No progress; if the rule explicitly accepts zero, it can show Completed. Missed means an elapsed required opportunity has no active saved check-in. An open opportunity today is Pending, and a future opportunity is Upcoming.

### ID: checkin-resave-same-date
**Category:** check-ins
**Question:** What happens if I save a check-in again for the same date?
**Aliases:**
- Can a tracker have two check-ins on one day?
- Does saving another entry replace my check-in for that date?
**Keywords:** same date, edit, save, latest revision, check-in
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/domain/trackers/planning.ts
**Answer:**
The app keeps one active check-in per tracker and date. Saving again updates that date’s entry, and calculations use the latest live revision rather than adding a second daily record.

### ID: checkin-note-vs-measure
**Category:** check-ins
**Question:** Does a check-in note count as a measure value?
**Aliases:**
- Can a note contribute to my numeric goal?
- Are custom answers included in tracker statistics?
**Keywords:** note, custom field, measure, metric, goal progress
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerConfigurationEditor.tsx
- src/features/shared/TrackerEntryFields.tsx
- src/domain/trackers/analytics.ts
**Answer:**
No. A note or custom check-in answer adds context to the entry. Goal calculations and measure statistics use tracker measure values, not those custom fields.
