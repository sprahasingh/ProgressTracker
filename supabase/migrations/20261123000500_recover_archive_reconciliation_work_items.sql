-- Isolate worker failures to one durable work item. A bad source record must
-- not roll back unrelated work or permanently starve later archive jobs.
begin;

alter table public.private_progression_archive_reconciliation_jobs
  add column failure_count integer not null default 0,
  add column last_error text,
  add column last_failed_at timestamptz,
  add column retry_after timestamptz not null default clock_timestamp();
create index private_progression_archive_jobs_retry_idx
  on public.private_progression_archive_reconciliation_jobs(retry_after, queued_at, user_id, tracker_id);


create or replace function public.process_progression_archive_reconciliation_batch(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_job public.private_progression_archive_reconciliation_jobs%rowtype;
  v_tracker public.trackers%rowtype;
  v_entry public.tracker_entries%rowtype;
  v_date date;
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_processed integer := 0;
  v_entries integer := 0;
  v_dates integer := 0;
  v_completed integer := 0;
  v_failures integer := 0;
begin
  perform public.enqueue_progression_archive_reconciliation_batch(least(v_limit, 200));
  while v_processed < v_limit loop
    select * into v_job
    from public.private_progression_archive_reconciliation_jobs j
    where j.retry_after <= clock_timestamp()
    order by j.retry_after, j.queued_at, j.user_id, j.tracker_id
    limit 1 for update skip locked;
    if not found then exit; end if;

    begin
      select * into v_tracker from public.trackers t
      where t.user_id = v_job.user_id and t.id = v_job.tracker_id and t.deleted_at is null;
      if not found then
        delete from public.private_progression_archive_reconciliation_jobs where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
        v_processed := v_processed + 1;
        continue;
      end if;

      if v_job.phase = 'entries' then
        select e.* into v_entry from public.tracker_entries e
        where e.user_id = v_job.user_id and e.tracker_id = v_job.tracker_id
          and e.entry_date between v_job.from_date and v_job.through_date
          and (v_job.entry_after_date is null or (e.entry_date, e.id) > (v_job.entry_after_date, v_job.entry_after_id))
        order by e.entry_date, e.id limit 1;
        if found then
          perform public.record_progression_entry_award(
            v_entry.user_id, v_entry.tracker_id, v_entry.id, v_entry.entry_date,
            v_entry.entry_values, v_entry.outcome, v_entry.deleted_at
          );
          update public.private_progression_archive_reconciliation_jobs
          set entry_after_date = v_entry.entry_date, entry_after_id = v_entry.id,
              failure_count = 0, last_error = null, last_failed_at = null,
              retry_after = clock_timestamp()
          where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
          v_entries := v_entries + 1;
          v_processed := v_processed + 1;
          continue;
        end if;
        update public.private_progression_archive_reconciliation_jobs
        set phase = 'dates', date_cursor = from_date - 1,
            failure_count = 0, last_error = null, last_failed_at = null,
            retry_after = clock_timestamp()
        where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
        v_processed := v_processed + 1;
        continue;
      end if;

      if v_job.date_cursor < v_job.through_date then
        v_date := greatest(v_job.from_date, v_job.date_cursor + 1);
        perform public.reconcile_progression_perfect_day(v_job.user_id, v_date);
        update public.private_progression_archive_reconciliation_jobs
        set date_cursor = v_date, failure_count = 0, last_error = null,
            last_failed_at = null, retry_after = clock_timestamp()
        where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
        v_dates := v_dates + 1;
        v_processed := v_processed + 1;
        continue;
      end if;

      perform public.reconcile_progression_tracker_milestones(v_job.user_id, v_job.tracker_id);
      perform public.reconcile_progression_goal_tracker(v_job.user_id, v_job.tracker_id);
      perform public.reconcile_progression_achievements(v_job.user_id);
      delete from public.private_progression_archive_reconciliation_jobs
      where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
      v_completed := v_completed + 1;
      v_processed := v_processed + 1;
    exception when others then
      update public.private_progression_archive_reconciliation_jobs
      set failure_count = failure_count + 1,
          last_error = sqlstate || ': ' || sqlerrm,
          last_failed_at = clock_timestamp(),
          retry_after = clock_timestamp() + make_interval(secs => least(3600, 5 * (2 ^ least(failure_count, 9)))::integer),
          queued_at = clock_timestamp()
      where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
      v_failures := v_failures + 1;
      v_processed := v_processed + 1;
    end;
  end loop;
  return jsonb_build_object(
    'processed', v_processed, 'entries', v_entries, 'dates', v_dates,
    'completed', v_completed, 'failures', v_failures,
    'remaining', (select count(*) from public.private_progression_archive_reconciliation_jobs),
    'retrying', (select count(*) from public.private_progression_archive_reconciliation_jobs where failure_count > 0)
  );
end;
$$;
revoke all on function public.process_progression_archive_reconciliation_batch(integer) from public, anon, authenticated;
grant execute on function public.process_progression_archive_reconciliation_batch(integer) to service_role;

commit;
