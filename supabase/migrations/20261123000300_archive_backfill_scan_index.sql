-- The one-time archive inventory uses this partial index in bounded slices.
-- Concurrent creation avoids blocking tracker writes during the index build.
create index concurrently if not exists trackers_archived_reconciliation_scan_idx
  on public.trackers (user_id, id)
  where status = 'archived' and deleted_at is null and definition ? 'archivedAt';
