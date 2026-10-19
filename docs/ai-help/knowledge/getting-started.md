# Getting started

### ID: guest-mode
**Category:** getting-started
**Question:** Can I use ProgressTracker as a guest?
**Aliases:**
- Do I need an account to start tracking?
- What happens to guest data?
**Keywords:** guest, account, local storage, sign in, tracker
**Suggestible:** true
**Sources:**
- src/features/auth/AuthProvider.tsx
- src/db/localRepository.ts
- src/features/auth/AuthPage.tsx
- src/features/auth/AuthProvider.test.tsx
**Answer:**
You can use ProgressTracker without signing in. Guest tracker data is stored locally in the browser on that device. Signing in enables account synchronization, but guest data does not automatically appear on another device.

### ID: create-tracker
**Category:** getting-started
**Question:** How do I create a tracker?
**Aliases:**
- How do I start tracking a habit?
- Where do I add a new tracker?
**Keywords:** create, setup, habit, goal, schedule, measure
**Suggestible:** true
**Sources:**
- src/features/trackers/TrackerSetupPage.tsx
- src/features/trackers/TrackerSetupPage.test.tsx
- src/features/trackers/trackerSetupSchema.ts
- src/features/trackers/TrackerConfigurationEditor.tsx
**Answer:**
Open Trackers and choose Create tracker. Give it a name, choose the tracker kind and measures, then set its schedule and active dates. For a goal, open Plan targets and pace to set a daily target or a total to reach by a deadline. The target and deadline in that section are also used by the goal plan. Save the form to begin using it. Every measure supports Yes/No, Quantity, Duration, or Checklist values. The new primary measure defaults to **Status** for Yes/No, **Progress** for Quantity, **Time Spent** for Duration, and **Items** for Checklist. These are editable names; while setting up a new tracker, changing the type updates the default name unless you already edited it. Added secondary measures start with a generic name such as **Measure 2** and Quantity type. Names are saved with the tracker; older trackers retain their existing names, and a measure with history cannot be renamed. New trackers default to using the Success Rule for streaks; choose a custom Streak Rule in More options when streak progress should follow a different condition. Existing trackers keep their original streak behavior until explicitly changed.
