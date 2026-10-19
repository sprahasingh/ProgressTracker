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
Appearance is stored locally on each device. A signed-in workspace's time zone is saved to the account and synchronized between devices; guest workspaces keep it locally.

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

### ID: feedback-identity-sharing
**Category:** settings-privacy
**Question:** How do I control whether maintainers see my details in feedback?
**Aliases:**
- Can I send feedback anonymously?
- Where do I turn off sharing my name and email?
- Does sharing apply to every support request?
**Keywords:** privacy, feedback, support, name, email, anonymous, sharing
**Suggestible:** true
**Sources:**
- src/features/settings/IdentitySharingSettings.tsx
- src/features/settings/identitySharing.ts
- src/features/feedback/SendFeedback.tsx
- supabase/migrations/20261118000300_default_identity_sharing_to_on.sql
- supabase/migrations/20261031000200_identity_sharing_privacy.sql
**Answer:**
In Settings, use “Share my details with maintainers” to choose whether maintainers may see your identity for feedback and support requests. Sharing appears enabled by default when you have not made a choice, but that default is not explicit consent: use **Confirm sharing preference** in Settings to save an opt-in. Maintainers can see identity only when you explicitly opted in and the request's saved identity-consent snapshot also allows it. An explicit opt-out, an unchosen default, a missing preference, or a failed preference lookup keeps identity hidden. A request submitted without identity consent stays anonymous if you opt in later. When disclosure is allowed, maintainers may see your account name and eligible confirmed email; support requests also require the request's separate email-sharing choice before showing email. Turning sharing off withdraws identity from stored requests where possible, but cannot recall information already viewed or exported. Account identifiers remain in use internally for account operation.
