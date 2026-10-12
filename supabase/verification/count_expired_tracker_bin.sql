-- Read-only pre-activation estimate. This returns a count and no tracker content.
-- It uses the same server-clock boundary as purge_expired_tracker_bin().
select count(*) as currently_eligible_tracker_count
from public.trackers
where deleted_at <= clock_timestamp() - interval '30 days';
