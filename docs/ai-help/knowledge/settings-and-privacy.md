# Settings and privacy

### ID: local-settings
**Category:** settings-privacy
**Question:** Do my appearance and time zone settings sync?
**Aliases:**
- Will dark mode carry to another device?
- Does changing my time zone sync to my account?
**Keywords:** appearance, time zone, settings, local, sync
**Suggestible:** true
**Sources:**
- src/features/settings/appearance.ts
- src/features/settings/WorkspaceTimeZone.tsx
- src/services/supabase/syncEngine.ts
- src/features/settings/appearance.test.ts
- src/features/settings/WorkspaceAppearance.test.tsx
**Answer:**
Appearance and workspace time-zone preferences are stored locally and are not part of the account records synchronized between devices. Set them separately on each device where you use the app.

### ID: timezone-dates
**Category:** settings-privacy
**Question:** Do check-in dates change when I change my time zone?
**Aliases:**
- Will my old entries move to a different day?
- How does the workspace time zone affect tracking?
**Keywords:** time zone, calendar date, historical, check-in, local date
**Suggestible:** true
**Sources:**
- src/features/settings/WorkspaceTimeZone.tsx
- src/db/calendarDate.ts
- src/db/calendarDate.test.ts
**Answer:**
Check-ins are stored by calendar date, so changing the workspace time zone does not shift already saved entries to another day. The selected time zone affects how dates and new daily boundaries are interpreted.
