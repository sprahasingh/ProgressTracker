# Accounts and synchronization

### ID: offline-sync
**Category:** accounts-sync
**Question:** Can I use ProgressTracker without internet?
**Aliases:**
- What happens when I go offline?
- Will my changes sync later?
- Can I use this without internet?
**Keywords:** offline, local, sync, internet, device
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/services/supabase/syncEngine.ts
- src/features/auth/AuthProvider.tsx
**Answer:**
Tracker data is stored locally in the browser, so you can continue working while offline. Signed-in account data synchronizes when a connection is available again. Until then, changes on that device may not appear elsewhere.

### ID: cross-device-sync
**Category:** accounts-sync
**Question:** Will my progress appear on another device?
**Aliases:**
- How do I sync trackers between devices?
- Can I access my data on a new device?
**Keywords:** account, sign in, sync, devices, cloud
**Suggestible:** true
**Sources:**
- src/features/auth/AuthProvider.tsx
- src/services/supabase/syncEngine.ts
**Answer:**
Cross-device synchronization is available when you sign in to the same account and the devices are online. Guest data is stored locally on the device and does not automatically appear on another device.

### ID: sync-conflicts
**Category:** accounts-sync
**Question:** What happens if two devices edit the same day?
**Aliases:**
- How does sync handle conflicting edits?
- Will ProgressTracker merge two versions automatically?
**Keywords:** conflict, revision, sync, devices, edit
**Suggestible:** true
**Sources:**
- src/services/supabase/syncEngine.ts
- src/db/syncConflictRepository.ts
- src/db/syncConflictRepository.test.ts
**Answer:**
When edits cannot be reconciled safely, sync records a conflict for you to resolve instead of silently combining incompatible versions. Review the conflict in the app’s sync/conflict flow; do not assume both edits were merged.

### ID: account-signin
**Category:** accounts-sync
**Question:** How do I sign in or create an account?
**Aliases:**
- Can I sign in with an email link?
- How do I register?
**Keywords:** sign in, create account, email link, password, authentication
**Suggestible:** true
**Sources:**
- src/features/auth/AuthPage.tsx
- src/features/auth/authService.ts
- src/features/auth/AuthPage.test.tsx
**Answer:**
Use the account screen to request an email sign-in link or choose password sign-in. Choose Create account when registering a new account; using an email sign-in link for the first time creates an account for that email.

### ID: workspace-backup
**Category:** accounts-sync
**Question:** Can I back up or restore my workspace data?
**Aliases:**
- How do I export my progress?
- Can I import a workspace backup?
**Keywords:** backup, export, restore, JSON, workspace, sync conflicts
**Suggestible:** true
**Sources:**
- src/features/auth/WorkspaceBackup.tsx
- src/db/workspaceBackup.ts
- src/db/workspaceBackup.test.ts
**Answer:**
Settings provides a local workspace backup you can download as JSON and restore into the same guest workspace or account. Restore previews changes, adds missing records, skips identical records, and stops if it finds a conflicting ID or date. Keep the backup file private.

### ID: signout-local-data
**Category:** accounts-sync
**Question:** What happens to local workspace data when I sign out?
**Aliases:**
- Does signing out erase check-ins from this device?
- Will my local progress remain after sign-out?
**Keywords:** sign out, local workspace, check-ins, data, account
**Suggestible:** true
**Sources:**
- src/features/auth/AuthProvider.tsx
- src/db/localRepository.ts
**Answer:**
Signing out ends the account session; it does not itself delete the local workspace records. Account data remains associated with its local workspace, and the app uses a workspace-selection step when choosing guest data after sign-out.

### ID: offline-sync-later
**Category:** accounts-sync
**Question:** What happens to a check-in I save while offline?
**Aliases:**
- Will my offline entry upload when I reconnect?
- Does a disconnected check-in stay on this device?
**Keywords:** offline check-in, pending sync, reconnect, local storage
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/services/supabase/syncEngine.ts
- src/features/auth/AuthProvider.tsx
**Answer:**
The check-in is saved locally and its account-sync work remains pending until a connection is available. It may not appear on another device before synchronization completes.

### ID: sync-deletion
**Category:** accounts-sync
**Question:** Does clearing a check-in sync to my other devices?
**Aliases:**
- Will a cleared entry disappear from my other device?
- Does a check-in deletion upload when I reconnect?
**Keywords:** clear check-in, sync, other devices, deletion marker
**Suggestible:** true
**Sources:**
- src/db/localRepository.ts
- src/services/supabase/syncEngine.ts
**Answer:**
For a signed-in account, clearing queues a deletion update for synchronization. Other devices reflect the change after they synchronize with the account; while offline, they may still show their earlier local copy.

### ID: sync-conflict-preserves-versions
**Category:** accounts-sync
**Question:** What information is kept when two device edits conflict?
**Aliases:**
- Does sync keep both versions of a conflict?
- Can ProgressTracker merge conflicting tracker changes automatically?
**Keywords:** sync conflict, local version, remote version, revision, resolution
**Suggestible:** true
**Sources:**
- src/services/supabase/syncEngine.ts
- src/db/syncConflictRepository.ts
- src/db/syncConflictRepository.test.ts
**Answer:**
When a revision conflict cannot be reconciled safely, the sync flow records the conflicting local and remote data for you to resolve. It does not silently blend incompatible changes. Review the conflict before choosing which version to keep.

### ID: sync-preference-scope
**Category:** accounts-sync
**Question:** Do workspace time zone and appearance settings sync between devices?
**Aliases:**
- Will my theme and calendar time zone follow me to another device?
- Are workspace display preferences stored in my account?
**Keywords:** settings, time zone, appearance, sync, devices
**Suggestible:** true
**Sources:**
- src/features/settings/WorkspaceTimeZone.tsx
- src/features/settings/appearance.ts
- src/features/settings/UnifiedSettings.test.tsx
**Answer:**
No. The workspace time zone and appearance preferences are stored locally and currently do not synchronize between devices. Set them separately in each workspace.
