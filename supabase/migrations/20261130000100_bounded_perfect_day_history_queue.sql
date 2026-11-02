-- Durable, bounded repair for missed Perfect Day history.
-- Page refresh only reports progress and queue status. A scheduled worker does
-- historical reconciliation in small resumable batches using the canonical
-- date-effective evaluator. The existing unique indexes on tracker_entries
-- cover both the global id cursor and owner/tracker/date lookups, so this
-- migration does not create duplicate scan indexes.
begin;

create table if not exists public.progression_perfect_day_repair_queue (
  user_id uuid not null,
  entry_date date not null,
  queued_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_sqlstate text check (last_sqlstate is null or length(last_sqlstate) = 5),
  primary key (user_id, entry_date)
);
alter table public.progression_perfect_day_repair_queue
  drop constraint if exists progression_perfect_day_repair_queue_user_fk;
create index if not exists progression_perfect_day_repair_ready_idx
  on public.progression_perfect_day_repair_queue(next_attempt_at, queued_at, user_id, entry_date);
alter table public.progression_perfect_day_repair_queue enable row level security;
revoke all on public.progression_perfect_day_repair_queue from public, anon, authenticated, service_role;

create table if not exists public.progression_perfect_day_backfill_state (
  singleton boolean primary key default true check (singleton),
  upper_entry_id uuid,
  last_entry_id uuid,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.progression_perfect_day_backfill_state enable row level security;
revoke all on public.progression_perfect_day_backfill_state from public, anon, authenticated, service_role;

create table if not exists public.progression_perfect_day_tracker_jobs (
  user_id uuid not null,
  tracker_id uuid not null,
  last_entry_date date,
  queued_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_sqlstate text check (last_sqlstate is null or length(last_sqlstate)=5),
  primary key (user_id, tracker_id)
);
alter table public.progression_perfect_day_tracker_jobs
  drop constraint if exists progression_perfect_day_tracker_jobs_user_fk;
create index if not exists progression_perfect_day_tracker_jobs_ready_idx
  on public.progression_perfect_day_tracker_jobs(next_attempt_at,queued_at,user_id,tracker_id);
alter table public.progression_perfect_day_tracker_jobs enable row level security;
revoke all on public.progression_perfect_day_tracker_jobs from public, anon, authenticated, service_role;

create or replace function public.cleanup_perfect_day_queue_after_owner_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.progression_perfect_day_repair_queue where user_id=old.id;
  delete from public.progression_perfect_day_tracker_jobs where user_id=old.id;
  return old;
end;
$$;
revoke all on function public.cleanup_perfect_day_queue_after_owner_delete() from public,anon,authenticated,service_role;
drop trigger if exists zzz_progression_perfect_day_queue_cleanup_after_owner_delete on auth.users;
create trigger zzz_progression_perfect_day_queue_cleanup_after_owner_delete
after delete on auth.users for each row execute function public.cleanup_perfect_day_queue_after_owner_delete();

create or replace function public.enqueue_perfect_day_repair(p_user_id uuid, p_entry_date date)
returns void language sql security definer set search_path = '' as $$
  insert into public.progression_perfect_day_repair_queue(user_id, entry_date)
  select p_user_id, p_entry_date
  where p_user_id is not null and p_entry_date is not null
    and exists(select 1 from auth.users u where u.id=p_user_id)
  on conflict (user_id, entry_date) do update
    set queued_at = least(public.progression_perfect_day_repair_queue.queued_at, excluded.queued_at),
        next_attempt_at = least(public.progression_perfect_day_repair_queue.next_attempt_at, excluded.next_attempt_at)
$$;
revoke all on function public.enqueue_perfect_day_repair(uuid,date) from public, anon, authenticated, service_role;

create or replace function public.queue_perfect_day_entry_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    perform public.enqueue_perfect_day_repair(old.user_id, old.entry_date);
  end if;
  perform public.enqueue_perfect_day_repair(new.user_id, new.entry_date);
  return new;
end;
$$;
revoke all on function public.queue_perfect_day_entry_change() from public, anon, authenticated, service_role;
drop trigger if exists tracker_entries_perfect_day_repair_queue on public.tracker_entries;
create trigger tracker_entries_perfect_day_repair_queue
after insert or update of tracker_id, entry_date, entry_values, outcome, holiday_treatment, deleted_at
on public.tracker_entries for each row execute function public.queue_perfect_day_entry_change();

create or replace function public.queue_perfect_day_entry_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.enqueue_perfect_day_repair(old.user_id,old.entry_date);
  return old;
end;
$$;
revoke all on function public.queue_perfect_day_entry_delete() from public,anon,authenticated,service_role;
drop trigger if exists tracker_entries_perfect_day_repair_delete on public.tracker_entries;
create trigger tracker_entries_perfect_day_repair_delete after delete on public.tracker_entries
for each row execute function public.queue_perfect_day_entry_delete();

create or replace function public.queue_perfect_day_tracker_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from auth.users u where u.id=old.user_id) then return old; end if;
  elsif not exists(select 1 from auth.users u where u.id=new.user_id) then
    return new;
  end if;
  if tg_op='UPDATE'
    and old.status is not distinct from new.status
    and old.deleted_at is not distinct from new.deleted_at
    and (old.definition - 'name' - 'description' - 'updatedAt' - 'updated_at')
      is not distinct from
        (new.definition - 'name' - 'description' - 'updatedAt' - 'updated_at') then
    return new;
  end if;
  insert into public.progression_perfect_day_tracker_jobs(user_id,tracker_id,last_entry_date,queued_at,next_attempt_at)
  values (case when tg_op='DELETE' then old.user_id else new.user_id end,
          case when tg_op='DELETE' then old.id else new.id end,null,clock_timestamp(),clock_timestamp())
  on conflict(user_id,tracker_id) do update set last_entry_date=null,queued_at=excluded.queued_at,
    next_attempt_at=excluded.next_attempt_at,attempts=0,last_sqlstate=null;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.queue_perfect_day_tracker_change() from public, anon, authenticated, service_role;
drop trigger if exists trackers_perfect_day_repair_queue on public.trackers;
create trigger trackers_perfect_day_repair_queue
after update of definition, status, deleted_at or delete on public.trackers
for each row execute function public.queue_perfect_day_tracker_change();

create or replace function public.queue_perfect_day_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' or tg_op='DELETE' then
    perform public.enqueue_perfect_day_repair(old.user_id,old.holiday_date);
  end if;
  if tg_op='INSERT' or tg_op='UPDATE' then
    perform public.enqueue_perfect_day_repair(new.user_id,new.holiday_date);
    return new;
  end if;
  return old;
end;
$$;
revoke all on function public.queue_perfect_day_holiday_change() from public,anon,authenticated,service_role;
drop trigger if exists tracker_holidays_perfect_day_repair_queue on public.tracker_holidays;
create trigger tracker_holidays_perfect_day_repair_queue after insert or update or delete on public.tracker_holidays
for each row execute function public.queue_perfect_day_holiday_change();
drop trigger if exists account_holidays_perfect_day_repair_queue on public.account_holidays;
create trigger account_holidays_perfect_day_repair_queue after insert or update or delete on public.account_holidays
for each row execute function public.queue_perfect_day_holiday_change();

create or replace function public.queue_perfect_day_timezone_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_old_timezone text;
  v_new_timezone text;
begin
  if tg_op='UPDATE' and old.timezone is not distinct from new.timezone then return new; end if;
  if tg_op='UPDATE' then
    v_old_timezone:=case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=old.timezone)
      then old.timezone else 'UTC' end;
    perform public.enqueue_perfect_day_repair(old.user_id,public.progression_local_date(v_now,v_old_timezone));
  end if;
  v_new_timezone:=case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=new.timezone)
    then new.timezone else 'UTC' end;
  perform public.enqueue_perfect_day_repair(new.user_id,public.progression_local_date(v_now,v_new_timezone));
  return new;
end;
$$;
revoke all on function public.queue_perfect_day_timezone_change() from public,anon,authenticated,service_role;
drop trigger if exists app_settings_enqueue_perfect_day_timezone on public.app_settings;
create trigger app_settings_enqueue_perfect_day_timezone after update of timezone on public.app_settings
for each row execute function public.queue_perfect_day_timezone_change();

-- Install every enqueue trigger before taking the backfill high-water mark.
-- Writes during concurrent index builds are then either covered by this cursor
-- or enqueued directly, even when a new UUID sorts below the high-water mark.
insert into public.progression_perfect_day_backfill_state(singleton, upper_entry_id)
select true, (select e.id from public.tracker_entries e order by e.id desc limit 1)
on conflict (singleton) do nothing;

create or replace function public.reconcile_perfect_day_repair_batch(p_limit integer default 50)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_item record;
  v_timezone text;
  v_today date;
  v_state text;
  v_processed integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_sqlstate text;
  v_users uuid[] := array[]::uuid[];
  v_user_id uuid;
  v_done jsonb := '[]'::jsonb;
begin
  -- Share the current-day worker lock so both canonical reconciliation paths
  -- cannot append/reverse the same award concurrently.
  if not pg_catalog.pg_try_advisory_xact_lock(78120426000100::bigint) then return 0; end if;
  for v_item in
    select q.user_id, q.entry_date
    from public.progression_perfect_day_repair_queue q
    join public.app_settings s on s.user_id = q.user_id
    where q.next_attempt_at <= clock_timestamp()
      and q.entry_date <= public.progression_local_date(clock_timestamp(),
        case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone)
          then s.timezone else 'UTC' end)
    order by q.next_attempt_at, q.queued_at, q.user_id, q.entry_date
    for update of q skip locked
    limit v_limit
  loop
    begin
      select case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone)
        then s.timezone else 'UTC' end into v_timezone
      from public.app_settings s where s.user_id=v_item.user_id;
      v_today := public.progression_local_date(clock_timestamp(), coalesce(v_timezone,'UTC'));
      if v_item.entry_date <= v_today then
        v_state := public.progression_evaluate_perfect_day(v_item.user_id, v_item.entry_date);
        -- Canonical reconciliation handles both newly qualifying dates and
        -- reversals required by eligibility-affecting edits. Its ledger is append-only.
        perform public.reconcile_progression_perfect_day(v_item.user_id, v_item.entry_date);
        if not (v_item.user_id = any(v_users)) then v_users := pg_catalog.array_append(v_users,v_item.user_id); end if;
      end if;
      v_done := v_done || jsonb_build_array(jsonb_build_object('user_id',v_item.user_id,'entry_date',v_item.entry_date));
      v_processed := v_processed+1;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      update public.progression_perfect_day_repair_queue
      set attempts=attempts+1,
          last_sqlstate=v_sqlstate,
          next_attempt_at=clock_timestamp()+least(interval '1 day', interval '1 minute' * power(2, least(attempts,10)))
      where user_id=v_item.user_id and entry_date=v_item.entry_date;
    end;
  end loop;
  if pg_catalog.cardinality(v_users)>0 then
    foreach v_user_id in array v_users loop
      begin
        perform public.reconcile_progression_achievements(v_user_id);
        delete from public.progression_perfect_day_repair_queue q
        using jsonb_to_recordset(v_done) as done(user_id uuid,entry_date date)
        where q.user_id=v_user_id and q.user_id=done.user_id and q.entry_date=done.entry_date;
      exception when others then
        get stacked diagnostics v_sqlstate=returned_sqlstate;
        update public.progression_perfect_day_repair_queue q
        set attempts=q.attempts+1,last_sqlstate=v_sqlstate,
            next_attempt_at=clock_timestamp()+least(interval '1 day',interval '1 minute'*power(2,least(q.attempts,10)))
        where q.user_id=v_user_id and q.entry_date in
          (select done.entry_date from jsonb_to_recordset(v_done) as done(user_id uuid,entry_date date)
           where done.user_id=v_user_id);
      end;
    end loop;
  end if;
  return v_processed;
end;
$$;
revoke all on function public.reconcile_perfect_day_repair_batch(integer) from public, anon, authenticated, service_role;

-- Keyset backfill over the immutable entry UUID index. Each call examines no
-- more than 500 rows; dates are filtered by each owner's reliable cutover and
-- local today, while the canonical evaluator validates date-effective rules.
create or replace function public.enqueue_perfect_day_backfill_batch(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_state public.progression_perfect_day_backfill_state%rowtype;
  v_entry record;
  v_timezone text;
  v_cutover date;
  v_today date;
  v_count integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit,500),500));
begin
  if not pg_catalog.pg_try_advisory_xact_lock(78120430000200::bigint) then return 0; end if;
  select * into v_state from public.progression_perfect_day_backfill_state where singleton for update;
  if not found or v_state.completed_at is not null then return 0; end if;
  for v_entry in
    select e.id,e.user_id,e.entry_date,s.timezone,a.initialized_at
    from public.tracker_entries e
    join public.app_settings s on s.user_id=e.user_id
    join public.progression_account_state a on a.user_id=e.user_id
    where e.id > coalesce(v_state.last_entry_id,'00000000-0000-0000-0000-000000000000'::uuid)
      and e.id <= v_state.upper_entry_id
    order by e.id limit v_limit
  loop
    v_timezone := case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=v_entry.timezone)
      then v_entry.timezone else 'UTC' end;
    v_today := public.progression_local_date(clock_timestamp(),v_timezone);
    v_cutover := greatest((v_entry.initialized_at at time zone v_timezone)::date,
      coalesce((select max((t.updated_at at time zone v_timezone)::date)
        from public.trackers t where t.user_id=v_entry.user_id and t.schema_version<10
          and t.status in ('active','archived') and t.deleted_at is null),
        (v_entry.initialized_at at time zone v_timezone)::date));
    if v_entry.entry_date between v_cutover and v_today then
      perform public.enqueue_perfect_day_repair(v_entry.user_id,v_entry.entry_date);
    end if;
    update public.progression_perfect_day_backfill_state
      set last_entry_id=v_entry.id,updated_at=clock_timestamp() where singleton;
    v_count:=v_count+1;
  end loop;
  if v_count=0 then
    update public.progression_perfect_day_backfill_state
      set completed_at=clock_timestamp(),updated_at=clock_timestamp() where singleton;
  end if;
  return v_count;
end;
$$;
revoke all on function public.enqueue_perfect_day_backfill_batch(integer) from public, anon, authenticated, service_role;

create or replace function public.enqueue_perfect_day_tracker_job_batch(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_job record;
  v_entry record;
  v_last_date date;
  v_sqlstate text;
  v_count integer := 0;
  v_limit integer := greatest(1,least(coalesce(p_limit,100),200));
begin
  if not pg_catalog.pg_try_advisory_xact_lock(78120430000300::bigint) then return 0; end if;
  for v_job in select * from public.progression_perfect_day_tracker_jobs where next_attempt_at<=clock_timestamp()
    order by next_attempt_at,queued_at,user_id,tracker_id
    for update skip locked limit v_limit loop
    begin
      v_last_date:=v_job.last_entry_date;
      for v_entry in
        select distinct e.entry_date from public.tracker_entries e
        where e.user_id=v_job.user_id and e.tracker_id=v_job.tracker_id
          and (v_last_date is null or e.entry_date>v_last_date)
        order by e.entry_date limit 100
      loop
        perform public.enqueue_perfect_day_repair(v_job.user_id,v_entry.entry_date);
        v_last_date:=v_entry.entry_date;
        v_count:=v_count+1;
      end loop;
      update public.progression_perfect_day_tracker_jobs set last_entry_date=v_last_date
        where user_id=v_job.user_id and tracker_id=v_job.tracker_id;
      if not exists(select 1 from public.tracker_entries e where e.user_id=v_job.user_id
        and e.tracker_id=v_job.tracker_id and (v_last_date is null or e.entry_date>v_last_date)) then
        delete from public.progression_perfect_day_tracker_jobs where user_id=v_job.user_id and tracker_id=v_job.tracker_id;
      else
        update public.progression_perfect_day_tracker_jobs set queued_at=clock_timestamp(),next_attempt_at=clock_timestamp()
          where user_id=v_job.user_id and tracker_id=v_job.tracker_id;
      end if;
    exception when others then
      get stacked diagnostics v_sqlstate=returned_sqlstate;
      update public.progression_perfect_day_tracker_jobs set attempts=attempts+1,last_sqlstate=v_sqlstate,
        next_attempt_at=clock_timestamp()+least(interval '1 day',interval '1 minute'*power(2,least(attempts,10))),
        queued_at=clock_timestamp() where user_id=v_job.user_id and tracker_id=v_job.tracker_id;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.enqueue_perfect_day_tracker_job_batch(integer) from public, anon, authenticated, service_role;

create or replace function public.run_perfect_day_history_repair_cycle()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.enqueue_perfect_day_backfill_batch(500);
  perform public.enqueue_perfect_day_tracker_job_batch(100);
  perform public.reconcile_perfect_day_repair_batch(50);
end;
$$;
revoke all on function public.run_perfect_day_history_repair_cycle() from public,anon,authenticated,service_role;

-- Preserve the legacy RPC contract but remove all historical scanning from a
-- page request. The durable worker/backfill owns repair; the RPC reports queue
-- state alongside server-confirmed achievement progress.
create or replace function public.reconcile_missing_perfect_days(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then return; end if;
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Owner mismatch' using errcode='42501';
  end if;
end;
$$;
revoke all on function public.reconcile_missing_perfect_days(uuid) from public, anon, authenticated, service_role;

create or replace function public.refresh_my_progression_qualification_progress()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_due_dates_pending boolean;
  v_tracker_jobs_pending boolean;
  v_backfill_pending boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  insert into public.progression_achievement_accounts(user_id,initialized_at)
    select v_user_id,initialized_at from public.progression_account_state where user_id=v_user_id
    on conflict(user_id) do nothing;
  select exists(
    select 1
    from public.progression_perfect_day_repair_queue q
    join public.app_settings s on s.user_id=q.user_id
    where q.user_id=v_user_id and q.entry_date<=public.progression_local_date(clock_timestamp(),
      case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone)
        then s.timezone else 'UTC' end)
  ) into v_due_dates_pending;
  select exists(
    select 1 from public.progression_perfect_day_tracker_jobs j where j.user_id=v_user_id
  ) into v_tracker_jobs_pending;
  select exists(
    select 1 from public.progression_perfect_day_backfill_state b
    join public.tracker_entries e on e.user_id=v_user_id
      and e.id>coalesce(b.last_entry_id,'00000000-0000-0000-0000-000000000000'::uuid)
      and e.id<=b.upper_entry_id
    where b.singleton and b.completed_at is null
  ) into v_backfill_pending;
  update public.progression_achievement_progress
  set qualification_details = (qualification_details - 'pending_dates') || jsonb_build_object(
    'pending_reconciliation', v_due_dates_pending or v_tracker_jobs_pending or v_backfill_pending,
    'pending_message', case
      when v_backfill_pending then 'Historical verification is scanning saved check-ins in the background.'
      when v_due_dates_pending then 'Historical dates are queued for server verification.'
      when v_tracker_jobs_pending then 'Historical tracker changes are being staged for server verification.'
      else null end),
    updated_at=clock_timestamp()
  where user_id=v_user_id and achievement_id in ('perfect-week','perfect-month','perfect-year');
end;
$$;
revoke all on function public.refresh_my_progression_qualification_progress() from public, anon, authenticated, service_role;
grant execute on function public.refresh_my_progression_qualification_progress() to authenticated;

do $$ declare v_job_id bigint; begin
  for v_job_id in select jobid from cron.job where jobname='progress-tracker-perfect-day-history-repair' loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule('progress-tracker-perfect-day-history-repair','* * * * *',
    'select public.run_perfect_day_history_repair_cycle();');
end $$;

comment on table public.progression_perfect_day_repair_queue is
  'Private owner/date queue for bounded canonical Perfect Day historical reconciliation; failed dates use SQLSTATE-only exponential retry.';
comment on function public.reconcile_perfect_day_repair_batch(integer) is
  'Processes at most 100 owner/date candidates with SKIP LOCKED, date-local future guards, per-date failure isolation, and one achievement reconciliation per affected owner.';
comment on function public.enqueue_perfect_day_backfill_batch(integer) is
  'Resumable one-time indexed backfill; examines at most 500 saved entries per call and respects account cutover, legacy boundaries, and account-local today.';

commit;

