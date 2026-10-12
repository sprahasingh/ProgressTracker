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
