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
**Answer:**
Open Trackers and choose Create tracker. Give it a name, choose the tracker kind and measures, then set its schedule and active dates. Save the form to begin using it. New measures support Yes/No or Quantity; some existing trackers can retain legacy measure types.
