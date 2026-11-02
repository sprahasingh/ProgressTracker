-- Bound periodic Perfect Day recovery by accounts, isolate failures, and rotate
-- through every configured account. This is forward-only; the prior migration
-- remains available for installations that have already applied it.
begin;

create table if not exists public.progression_perfect_day_worker_cursor (
  singleton boolean primary key default true check (singleton),
  last_user_id uuid,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.progression_perfect_day_worker_cursor(singleton,last_user_id)
values (true,null) on conflict(singleton) do nothing;
alter table public.progression_perfect_day_worker_cursor enable row level security;
revoke all on public.progression_perfect_day_worker_cursor from public,anon,authenticated,service_role;

create table if not exists public.progression_perfect_day_worker_failures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failure_count integer not null default 1 check (failure_count > 0),
  last_sqlstate text not null check (length(last_sqlstate) = 5),
  last_failed_at timestamptz not null default clock_timestamp()
);
alter table public.progression_perfect_day_worker_failures enable row level security;
revoke all on public.progression_perfect_day_worker_failures from public,anon,authenticated,service_role;

create or replace function public.reconcile_current_perfect_days(p_limit integer default 50)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_users uuid[];
  v_user_id uuid;
  v_last_user_id uuid;
  v_timezone text;
  v_today date;
  v_award_key uuid;
  v_state text;
  v_processed integer := 0;
  v_limit integer := greatest(1,least(coalesce(p_limit,50),50));
  v_now timestamptz := clock_timestamp();
  v_sqlstate text;
begin
  -- One global transaction lock prevents overlapping cron invocations. A
  -- second invocation exits quickly; account rotation resumes next run.
  if not pg_catalog.pg_try_advisory_xact_lock(78120426000100::bigint) then
    return 0;
  end if;

  select c.last_user_id into v_last_user_id
  from public.progression_perfect_day_worker_cursor c
  where c.singleton
  for update;

  -- app_settings.user_id is its primary key. Keyset pages are strictly capped
  -- at 50 rows; a saved UUID cursor makes each cycle fair even with failures.
  select pg_catalog.array_agg(page.user_id order by page.user_id) into v_users
  from (
    select s.user_id
    from public.app_settings s
    where s.user_id > coalesce(v_last_user_id,'00000000-0000-0000-0000-000000000000'::uuid)
    order by s.user_id
    limit v_limit
  ) page;

  -- At end of the keyspace, wrap around in the same run. This prevents a
  -- trailing short page from making users at the beginning wait an extra cycle.
  if coalesce(pg_catalog.cardinality(v_users),0)=0 then
    select pg_catalog.array_agg(page.user_id order by page.user_id) into v_users
    from (
      select s.user_id
      from public.app_settings s
      order by s.user_id
      limit v_limit
    ) page;
  end if;

  if coalesce(pg_catalog.cardinality(v_users),0)=0 then
    update public.progression_perfect_day_worker_cursor
      set last_user_id=null,updated_at=v_now where singleton;
    return 0;
  end if;

  foreach v_user_id in array v_users loop
    begin
      select case when exists (
          select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone
        ) then s.timezone else 'UTC' end
        into v_timezone
      from public.app_settings s
      join public.progression_account_state a on a.user_id=s.user_id
      where s.user_id=v_user_id and s.timezone_configured;
      if not found then
        update public.progression_perfect_day_worker_cursor
          set last_user_id=v_user_id,updated_at=v_now where singleton;
        continue;
      end if;

      v_today := public.progression_local_date(v_now,v_timezone);
      if v_today is null then
        v_today := (v_now at time zone 'UTC')::date;
      end if;
      v_award_key := pg_catalog.md5(v_user_id::text || ':perfect-day:' || v_today::text)::uuid;

      -- The expensive canonical evaluation happens only after the bounded
      -- account page has been selected, and exactly once per selected account.
      if not exists (
        select 1 from public.progression_award_state s
        where s.user_id=v_user_id and s.award_key=v_award_key
          and s.reason_code='PERFECT_DAY_BONUS' and s.current_xp>0
      ) then
        v_state := public.progression_evaluate_perfect_day(v_user_id,v_today);
        if v_state='perfect' then
          perform public.reconcile_progression_perfect_day(v_user_id,v_today);
          if exists (
            select 1 from public.progression_award_state s
            where s.user_id=v_user_id and s.award_key=v_award_key
              and s.reason_code='PERFECT_DAY_BONUS' and s.current_xp>0
          ) then
            -- Reconcile the achievement ledger once, after the affected date,
            -- never once per candidate date.
            perform public.reconcile_progression_achievements(v_user_id);
            delete from public.progression_perfect_day_worker_failures f where f.user_id=v_user_id;
            v_processed := v_processed+1;
          end if;
        end if;
      end if;
      update public.progression_perfect_day_worker_cursor
        set last_user_id=v_user_id,updated_at=v_now where singleton;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      insert into public.progression_perfect_day_worker_failures(user_id,failure_count,last_sqlstate,last_failed_at)
      values (v_user_id,1,v_sqlstate,v_now)
      on conflict(user_id) do update set
        failure_count=least(public.progression_perfect_day_worker_failures.failure_count::bigint+1,2147483647)::integer,
        last_sqlstate=excluded.last_sqlstate,
        last_failed_at=excluded.last_failed_at;
      -- Do not include SQL error text or account details in cron output. The
      -- failure table is inaccessible to clients and stores only SQLSTATE.
      update public.progression_perfect_day_worker_cursor
        set last_user_id=v_user_id,updated_at=v_now where singleton;
    end;
  end loop;
  return v_processed;
end;
$$;
revoke all on function public.reconcile_current_perfect_days(integer) from public,anon,authenticated,service_role;

comment on table public.progression_perfect_day_worker_failures is
  'Private aggregate diagnostics for isolated scheduled Perfect Day worker failures; stores SQLSTATE only.';
comment on function public.reconcile_current_perfect_days(integer) is
  'Fair, non-overlapping five-minute recovery worker. Evaluates at most 50 configured account-local dates per run and records per-account SQLSTATE failures without exposing account data.';

do $$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='progress-tracker-current-perfect-days' loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule('progress-tracker-current-perfect-days','*/5 * * * *',
    'select public.reconcile_current_perfect_days(50);');
end;
$$;

commit;
