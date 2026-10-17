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
- src/db/syncRecoveryRepository.ts
- src/db/syncRecoveryRepository.test.ts
- src/db/trackerRecoveryPreview.ts
- src/features/auth/AuthPage.tsx
- src/features/auth/AuthPage.test.tsx
- src/features/auth/BlockedTrackerSyncCard.tsx
- src/features/auth/TrackerRecoveryPreview.tsx
**Answer:**
When two saved versions have different cloud revisions, sync preserves the local and cloud copies and asks you to review them under Account → Sync conflicts. Choose which version to keep, or save the local record under a new ID when no cloud record is readable. Permanent server validation rejections remain blocked with their payloads and diagnostics; **Try again** is disabled for these errors, and the unchanged payload is never replayed. A transient retry first checks the local operation and current cloud revision; changed cloud state becomes a conflict. **Undo unsynced changes** is available for a tracker when its latest confirmed cloud definition can be restored safely. It previews the exact definition changes and requires a verified backup and explicit confirmation. It preserves valid independent check-ins and stops when there is no verified same-schema or conversion path, a measure identity or type changes unsafely, the acknowledged cloud revision is stale, or a related conflict or deletion request needs review. Guarded **Repair Changes** appears under **Other recovery options** when the preview offers a verified correction. Check-ins and permanent-deletion requests for a tracker with a blocked or conflicted tracker-definition write stay queued until a newer definition is acknowledged. Superseded rejections remain labeled as historical without deleting their saved payloads.

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
Settings provides a local workspace backup you can download as JSON and restore into the same guest workspace or account. Restore previews changes, adds missing records, skips identical records, and stops if it finds a conflicting ID or date. Sync operation states are preserved too: a server-rejected change remains blocked with its payload and diagnostic, an explicitly discarded change remains inert with its audit payload, and an already superseded operation remains historical; none is made retryable by restoring a backup. Keep the backup file private.

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
The check-in is saved locally and its account-sync work remains pending until a connection is available. If that tracker has a blocked or conflicted definition change, the check-in stays queued until a newer definition is acknowledged. It may not appear on another device before synchronization completes.

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
When a revision conflict cannot be reconciled safely, the sync flow records the conflicting local and remote data for you to resolve. It does not silently blend incompatible changes. Review the conflict under Account → Sync conflicts before choosing which version to keep. If the server permanently rejects a write for validation, the local payload is retained as a blocked operation instead of being retried automatically or presented as a competing cloud version.

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
Appearance is stored locally on each device. A signed-in workspace's time zone is saved to the account and synchronized between devices; guest workspaces keep it locally.
