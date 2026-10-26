-- Reconcile holiday-dependent check-in credits and archive boundary changes.
-- Archive work is queued and processed in bounded batches; no tracker history
-- is synchronously rescored by an archive-only definition update.
begin;

create table public.private_progression_archive_reconciliation_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  tracker_id uuid not null,
  from_date date not null,
  through_date date not null,
  phase text not null default 'entries' check (phase in ('entries', 'dates')),
  entry_after_date date,
  entry_after_id uuid,
  date_cursor date,
  queued_at timestamptz not null default clock_timestamp(),
  primary key (user_id, tracker_id),
  foreign key (user_id, tracker_id) references public.trackers(user_id, id) on delete cascade,
  check (through_date >= from_date),
  check ((entry_after_date is null) = (entry_after_id is null))
);
alter table public.private_progression_archive_reconciliation_jobs enable row level security;
revoke all on public.private_progression_archive_reconciliation_jobs from public, anon, authenticated, service_role;
create index private_progression_archive_jobs_queued_idx
  on public.private_progression_archive_reconciliation_jobs(queued_at, user_id, tracker_id);

create or replace function public.progression_tracker_change_is_archive_only(
  p_old public.trackers, p_new public.trackers
)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_old.status in ('active', 'archived')
    and p_new.status in ('active', 'archived')
    and p_old.schema_version = p_new.schema_version
    and p_old.kind = p_new.kind
    and p_old.name = p_new.name
    and p_old.deleted_at is not distinct from p_new.deleted_at
    and (p_old.status, p_old.definition->>'archivedAt') is distinct from
        (p_new.status, p_new.definition->>'archivedAt')
    and (p_old.definition - 'status' - 'archivedAt' - 'updatedAt') is not distinct from
        (p_new.definition - 'status' - 'archivedAt' - 'updatedAt');
$$;
revoke all on function public.progression_tracker_change_is_archive_only(public.trackers, public.trackers) from public, anon, authenticated, service_role;

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
    queued_at = clock_timestamp();
end;
$$;
revoke all on function public.queue_progression_archive_reconciliation(uuid, uuid, date, date) from public, anon, authenticated, service_role;

create or replace function public.queue_progression_archive_change(
  p_old public.trackers, p_new public.trackers
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_archive_date date;
  v_new_archive_date date;
  v_boundary date;
  v_timezone text := 'UTC';
  v_through date;
begin
  if not public.progression_tracker_change_is_archive_only(p_old, p_new) then return; end if;
  if p_old.definition->>'archivedAt' is not null then v_old_archive_date := pg_catalog.left(p_old.definition->>'archivedAt', 10)::date; end if;
  if p_new.definition->>'archivedAt' is not null then v_new_archive_date := pg_catalog.left(p_new.definition->>'archivedAt', 10)::date; end if;
  v_boundary := coalesce(least(v_old_archive_date, v_new_archive_date), v_old_archive_date, v_new_archive_date);
  if v_boundary is null then return; end if;
  select coalesce(s.timezone, 'UTC') into v_timezone from public.app_settings s where s.user_id = new.user_id;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_through := (clock_timestamp() at time zone v_timezone)::date;
  perform public.queue_progression_archive_reconciliation(p_new.user_id, p_new.id, v_boundary + 1, v_through);
end;
$$;
revoke all on function public.queue_progression_archive_change(public.trackers, public.trackers) from public, anon, authenticated, service_role;

-- The generic tracker trigger replays every entry on any meaningful definition
-- update. For archive-only changes, enqueue the affected date suffix instead.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.reconcile_progression_tracker_trigger()'::regprocedure);
  v_anchor text := E'begin\n  for v_entry in select * from public.tracker_entries where user_id=new.user_id and tracker_id=new.id loop';
  v_replacement text := E'begin\n  if tg_op = ''UPDATE'' and public.progression_tracker_change_is_archive_only(old, new) then\n    perform public.queue_progression_archive_change(old, new);\n    return new;\n  end if;\n  for v_entry in select * from public.tracker_entries where user_id=new.user_id and tracker_id=new.id loop';
begin
  if pg_catalog.strpos(v_definition, v_anchor) = 0 then
    raise exception 'tracker progression trigger changed; bounded archive reconciliation needs review';
  end if;
  execute pg_catalog.replace(v_definition, v_anchor, v_replacement);
end;
$$;

-- The separately named achievement trigger must not publish intermediate
-- state while the bounded archive job is still reconciling its source dates.
drop trigger if exists z_progression_achievement_tracker_update on public.trackers;
create trigger z_progression_achievement_tracker_update
after update on public.trackers
for each row
when (
  (old.status, old.kind, old.name, old.definition - 'deletedAt' - 'updatedAt')
    is distinct from
  (new.status, new.kind, new.name, new.definition - 'deletedAt' - 'updatedAt')
  and not public.progression_tracker_change_is_archive_only(old, new)
)
execute function public.reconcile_progression_achievements_trigger();

-- Historical snapshots already make v10 XP, streak, Perfect Day, and
-- achievement scorers date-effective. Fail closed if a later migration has
-- replaced that contract with current-definition scoring.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure
  );
begin
  if pg_catalog.strpos(v_definition,
       'progression_entry_success_qualifies(public.progression_tracker_definition_for_date(v_tracker.definition, p_entry_date)') = 0 then
    raise exception 'progression award scorer no longer resolves the date-effective tracker definition';
  end if;
end;
$$;

create or replace function public.reconcile_progression_entries_for_date(
  p_user_id uuid, p_tracker_id uuid, p_date date
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_entry public.tracker_entries%rowtype;
begin
  if p_user_id is null or p_tracker_id is null or p_date is null then return; end if;
  for v_entry in
    select e.* from public.tracker_entries e
    where e.user_id = p_user_id and e.tracker_id = p_tracker_id and e.entry_date = p_date
    order by e.id
  loop
    perform public.record_progression_entry_award(
      v_entry.user_id, v_entry.tracker_id, v_entry.id, v_entry.entry_date,
      v_entry.entry_values, v_entry.outcome, v_entry.deleted_at
    );
  end loop;
end;
$$;
revoke all on function public.reconcile_progression_entries_for_date(uuid, uuid, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_tracker_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_new_user uuid;
  v_user uuid;
  v_tracker uuid;
  v_date date;
  v_today date;
  v_timezone text;
begin
  if tg_op <> 'INSERT' then v_old_user := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.user_id; end if;
  for v_user in
    select distinct ids.user_id from unnest(array[v_old_user, v_new_user]) as ids(user_id) where ids.user_id is not null
  loop
    select coalesce(s.timezone, 'UTC') into v_timezone from public.app_settings s where s.user_id = v_user;
    v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
    for v_tracker, v_date in
      select distinct affected.tracker_id, affected.holiday_date from (
        select old.tracker_id, old.holiday_date where tg_op <> 'INSERT' and old.user_id = v_user
        union all
        select new.tracker_id, new.holiday_date where tg_op <> 'DELETE' and new.user_id = v_user
      ) affected where affected.tracker_id is not null and affected.holiday_date is not null
    loop
      perform public.reconcile_progression_entries_for_date(v_user, v_tracker, v_date);
      perform public.reconcile_progression_tracker_milestones(v_user, v_tracker);
      if v_date <= v_today then perform public.reconcile_progression_perfect_day(v_user, v_date); end if;
    end loop;
    perform public.reconcile_progression_achievements(v_user);
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_tracker_holiday_change() from public, anon, authenticated, service_role;

create or replace function public.reconcile_account_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_new_user uuid;
  v_user uuid;
  v_date date;
  v_today date;
  v_timezone text;
  v_tracker record;
begin
  if tg_op <> 'INSERT' then v_old_user := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.user_id; end if;
  for v_user in
    select distinct ids.user_id from unnest(array[v_old_user, v_new_user]) as ids(user_id) where ids.user_id is not null
  loop
    select coalesce(s.timezone, 'UTC') into v_timezone from public.app_settings s where s.user_id = v_user;
    v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
    for v_date in
      select distinct dates.holiday_date from (
        select old.holiday_date where tg_op <> 'INSERT' and old.user_id = v_user
        union all
        select new.holiday_date where tg_op <> 'DELETE' and new.user_id = v_user
      ) dates where dates.holiday_date is not null
    loop
      for v_tracker in
        select t.id from public.trackers t
        where t.user_id = v_user and t.deleted_at is null and t.status in ('active', 'archived')
      loop
        perform public.reconcile_progression_entries_for_date(v_user, v_tracker.id, v_date);
        perform public.reconcile_progression_tracker_milestones(v_user, v_tracker.id);
      end loop;
      if v_date <= v_today then perform public.reconcile_progression_perfect_day(v_user, v_date); end if;
    end loop;
    perform public.reconcile_progression_achievements(v_user);
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_account_holiday_change() from public, anon, authenticated, service_role;

-- One worker pass is bounded to 200 entries, local dates, or tracker finalizers.
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
begin
  while v_processed < v_limit loop
    select * into v_job
    from public.private_progression_archive_reconciliation_jobs j
    order by j.queued_at, j.user_id, j.tracker_id
    limit 1 for update skip locked;
    if not found then exit; end if;
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
        set entry_after_date = v_entry.entry_date, entry_after_id = v_entry.id
        where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
        v_entries := v_entries + 1;
        v_processed := v_processed + 1;
        continue;
      end if;
      update public.private_progression_archive_reconciliation_jobs
      set phase = 'dates', date_cursor = from_date - 1
      where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
      continue;
    end if;

    if v_job.date_cursor < v_job.through_date then
      v_date := greatest(v_job.from_date, v_job.date_cursor + 1);
      perform public.reconcile_progression_perfect_day(v_job.user_id, v_date);
      update public.private_progression_archive_reconciliation_jobs
      set date_cursor = v_date where user_id = v_job.user_id and tracker_id = v_job.tracker_id;
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
  end loop;
  return jsonb_build_object(
    'processed', v_processed, 'entries', v_entries, 'dates', v_dates,
    'completed', v_completed,
    'remaining', (select count(*) from public.private_progression_archive_reconciliation_jobs)
  );
end;
$$;
revoke all on function public.process_progression_archive_reconciliation_batch(integer) from public, anon, authenticated;
grant execute on function public.process_progression_archive_reconciliation_batch(integer) to service_role;

-- Supabase already installs pg_cron for tracker and holiday retention jobs.
-- Keep the migration bounded: each minute performs at most 200 work units.
do $$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname = 'progress-tracker-archive-reconciliation' loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule(
    'progress-tracker-archive-reconciliation', '* * * * *',
    'select public.process_progression_archive_reconciliation_batch(200);'
  );
end;
$$;

commit;
