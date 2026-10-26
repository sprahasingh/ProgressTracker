-- A new archive boundary or explicit backfill enqueue is fresh work. Clear a
-- prior transient failure's backoff and cursor when that work is requeued.
begin;

create or replace function public.queue_progression_archive_reconciliation(
  p_user_id uuid, p_tracker_id uuid, p_from_date date, p_through_date date
)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_tracker_id is null or p_from_date is null or p_through_date is null
     or p_from_date > p_through_date
     or not exists (select 1 from public.progression_account_state a where a.user_id = p_user_id) then
    return;
  end if;
  insert into public.private_progression_archive_reconciliation_jobs(
    user_id, tracker_id, from_date, through_date
  ) values (p_user_id, p_tracker_id, p_from_date, p_through_date)
  on conflict (user_id, tracker_id) do update set
    from_date = least(public.private_progression_archive_reconciliation_jobs.from_date, excluded.from_date),
    through_date = greatest(public.private_progression_archive_reconciliation_jobs.through_date, excluded.through_date),
    phase = 'entries', entry_after_date = null, entry_after_id = null, date_cursor = null,
    queued_at = clock_timestamp(), retry_after = clock_timestamp(),
    failure_count = 0, last_error = null, last_failed_at = null;
end;
$$;
revoke all on function public.queue_progression_archive_reconciliation(uuid, uuid, date, date) from public, anon, authenticated, service_role;

commit;
