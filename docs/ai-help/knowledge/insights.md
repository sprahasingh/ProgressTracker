# Insights

### ID: insight-tracker-cards
**Category:** insights
**Question:** What does the Your Trackers section show?
**Aliases:**
- What are the tracker cards in Insights?
- What information appears on an Insights tracker card?
**Keywords:** Insights, tracker cards, current date, status, streak, latest check-in
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/features/dashboard/DashboardPage.test.tsx
**Answer:**
Each active tracker card is a snapshot for the workspace-local current date. It shows today’s status, that tracker’s current streak and personal best, and its latest saved check-in with that entry’s date, outcome, and values. These refer to separate dates and purposes.

### ID: insight-current-status
**Category:** insights
**Question:** Does an Insights tracker card show today or my latest check-in?
**Aliases:**
- What date does a tracker card represent?
- Is the status on my tracker card from today or my last entry?
**Keywords:** Insights, snapshot date, current status, latest saved entry
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/features/dashboard/DashboardPage.test.tsx
**Answer:**
The card’s status and streak are a snapshot as of today in your workspace time zone. The separate “Latest check-in” area shows the newest saved entry and its actual date, which may be earlier.

### ID: insight-latest-checkin
**Category:** insights
**Question:** What does the latest check-in date on an Insights card mean?
**Aliases:**
- Does latest check-in mean I logged today?
- Why is the check-in date on my card from an earlier day?
**Keywords:** latest check-in, saved entry, date, Insights
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/db/localRepository.ts
**Answer:**
It is the date of the most recent active saved check-in for that tracker. It does not imply that you checked in today. Cleared entries are excluded; if no active entry exists, the card says “No check-ins yet.”

### ID: insight-empty-tracker
**Category:** insights
**Question:** Why does an Insights card say no check-ins yet?
**Aliases:**
- What does “No check-ins yet” mean on my tracker?
- Why is there no latest entry on a tracker card?
**Keywords:** Insights, empty tracker, no check-ins, latest entry
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/features/dashboard/DashboardPage.test.tsx
**Answer:**
There is no active saved check-in for that tracker. Today’s status is shown separately, so a holiday or rest day does not mean an unfinished check-in; it describes today’s tracking status.

### ID: insight-streak-personal-best
**Category:** insights
**Question:** What do current streak and personal best mean on an Insights card?
**Aliases:**
- What is the personal best on my tracker card?
- How are the two streak numbers on Insights different?
**Keywords:** current streak, personal best, longest streak, Insights
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/domain/trackers/progression.ts
- src/domain/trackers/progression.test.ts
**Answer:**
Current streak is the qualifying run through today under the tracker’s mode. Personal best is the longest qualifying run in its saved history. Standard Mode lets holidays and rest days preserve continuity without adding to the count; Strict Mode requires a qualifying entry on every active calendar date, including holidays and rest days.

### ID: insight-holiday-status
**Category:** insights
**Question:** Why does today’s card status differ from my latest check-in?
**Aliases:**
- Why does Insights show a holiday when my last entry was completed?
- Can the latest check-in and today’s status be different?
**Keywords:** Insights, today, holiday, latest check-in, current status
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/domain/trackers/activityStatus.ts
- src/features/dashboard/DashboardPage.test.tsx
**Answer:**
Today’s status and the latest saved check-in describe different dates. A holiday can be today’s workspace status while the latest check-in remains an earlier entry; the card labels that entry with its own date and outcome.

### ID: insight-timezone-date
**Category:** insights
**Question:** Which time zone determines the date shown in Insights?
**Aliases:**
- Is the Insights snapshot date local to my workspace?
- Why does the Insights date change around midnight?
**Keywords:** Insights, workspace time zone, snapshot date, midnight
**Suggestible:** true
**Sources:**
- src/features/dashboard/DashboardPage.tsx
- src/db/calendarDate.ts
- src/features/settings/WorkspaceTimeZone.tsx
**Answer:**
Insights uses the current date in the workspace’s selected time zone. Because that date can differ from UTC or your device’s other time zone, the snapshot may change at a different midnight.
