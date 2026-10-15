-- Strict calendar achievements use the same server-confirmed daily success
-- decision as Perfect Day. Preserve pre-policy awards under their old rules;
-- new week/month/year qualifications begin with the next complete period.
begin;

alter table public.progression_policy_cutovers
  add column perfect_year_start date not null default (date_trunc('year', current_date::timestamp) + interval '1 year')::date;

update public.progression_policy_cutovers
set perfect_week_start = date_trunc('week', current_date::timestamp)::date + 7,
    perfect_month_start = (date_trunc('month', current_date::timestamp) + interval '1 month')::date,
    perfect_year_start = (date_trunc('year', current_date::timestamp) + interval '1 year')::date
where id;

-- Evaluate Perfect Day while omitting a tracker before permanent deletion.
-- This mirrors the canonical daily success logic so deletion reconciliation
-- does not accidentally revoke an otherwise valid period.
create or replace function public.progression_evaluate_perfect_day_excluding(p_user_id uuid,p_date date,p_excluded_tracker_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_timezone text; v_today date; v_cutover date; v_definition_boundary date;
  v_required integer; v_qualified integer; v_failed integer; v_pending integer;
begin
  if p_user_id is null or p_date is null then return 'unsupported'; end if;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date,
    (a.initialized_at at time zone coalesce(s.timezone,'UTC'))::date
  into v_timezone,v_today,v_cutover
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id=a.user_id
  where a.user_id=p_user_id;
  if not found then return 'unsupported'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
    select (initialized_at at time zone 'UTC')::date into v_cutover from public.progression_achievement_accounts where user_id=p_user_id;
  end if;
  if p_date>v_today then return 'future'; end if;
  select greatest(v_cutover,coalesce(max((t.updated_at at time zone v_timezone)::date),v_cutover)) into v_definition_boundary
  from public.trackers t where t.user_id=p_user_id and t.id is distinct from p_excluded_tracker_id
    and t.status in ('active','archived') and t.deleted_at is null;
  if p_date<v_definition_boundary then return 'unsupported'; end if;
  select count(*)::integer,
    count(*) filter(where e.id is not null and e.deleted_at is null and e.outcome='recorded'
      and public.progression_entry_success_qualifies(t.definition,e.entry_values,e.outcome))::integer,
    count(*) filter(where e.outcome='skipped' or (e.id is not null and e.deleted_at is null and p_date<v_today
      and not public.progression_entry_success_qualifies(t.definition,e.entry_values,e.outcome))
      or (e.id is null and p_date<v_today))::integer,
    count(*) filter(where p_date=v_today and (e.id is null or (e.outcome='recorded'
      and not public.progression_entry_success_qualifies(t.definition,e.entry_values,e.outcome))))::integer
  into v_required,v_qualified,v_failed,v_pending
  from public.trackers t left join public.tracker_entries e on e.user_id=t.user_id and e.tracker_id=t.id and e.entry_date=p_date and e.deleted_at is null
  where t.user_id=p_user_id and t.id is distinct from p_excluded_tracker_id and t.status in ('active','archived') and t.deleted_at is null
    and (t.status<>'archived' or t.definition->>'archivedAt' is null or left(t.definition->>'archivedAt',10)::date>=p_date)
    and public.progression_date_is_eligible(p_user_id,t,p_date);
  if coalesce(v_required,0)=0 then return 'neutral'; end if;
  if coalesce(v_failed,0)>0 then return 'failed'; end if;
  if coalesce(v_pending,0)>0 then return 'pending'; end if;
  if v_qualified=v_required then return 'perfect'; end if;
  return 'failed';
end;
$$;
revoke all on function public.progression_evaluate_perfect_day_excluding(uuid,date,uuid) from public,anon,authenticated,service_role;

create or replace function public.progression_perfect_period_day_qualifies(p_user_id uuid,p_date date,p_excluded_tracker_id uuid default null)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text;
begin
  v_state:=case when p_excluded_tracker_id is null then public.progression_evaluate_perfect_day(p_user_id,p_date)
    else public.progression_evaluate_perfect_day_excluding(p_user_id,p_date,p_excluded_tracker_id) end;
  if v_state<>'perfect' then return false; end if;
  return exists(
    select 1 from public.trackers t
    join public.tracker_entries e on e.user_id=t.user_id and e.tracker_id=t.id and e.entry_date=p_date and e.deleted_at is null
    cross join lateral jsonb_array_elements(coalesce(t.definition->'metrics','[]'::jsonb)) m(metric)
    where t.user_id=p_user_id and t.id is distinct from p_excluded_tracker_id and t.status in ('active','archived') and t.deleted_at is null
      and (t.status<>'archived' or t.definition->>'archivedAt' is null or left(t.definition->>'archivedAt',10)::date>=p_date)
      and public.progression_date_is_eligible(p_user_id,t,p_date)
      and e.outcome='recorded' and public.progression_entry_success_qualifies(t.definition,e.entry_values,e.outcome)
      and m.metric->>'retiredAt' is null
      and (m.metric->>'valueType'='boolean'
        or exists(select 1 from jsonb_each(coalesce(m.metric->'thresholds','{}'::jsonb)) threshold(key,value)
          where jsonb_typeof(threshold.value)='number' and (threshold.value#>>'{}')::numeric>0)
        or case jsonb_typeof(e.entry_values->(m.metric->>'id'))
          when 'number' then (e.entry_values->>(m.metric->>'id'))::numeric>0
          when 'array' then jsonb_path_exists(e.entry_values->(m.metric->>'id'),'$[*] ? (@ == true)')
          when 'object' then exists(select 1 from jsonb_each(e.entry_values->(m.metric->>'id')) v where v.value='true'::jsonb)
          else false end)
  );
end;
$$;
revoke all on function public.progression_perfect_period_day_qualifies(uuid,date,uuid) from public,anon,authenticated,service_role;

-- Keep the former three-date week rule available only to validate awards made
-- before the strict policy cutover.
alter function public.progression_perfect_week_qualifies(uuid, date, uuid)
  rename to progression_perfect_week_qualifies_legacy;

create function public.progression_perfect_week_qualifies(
  p_user_id uuid, p_week_start date, p_excluded_tracker_id uuid default null
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy_start date;
  v_timezone text;
  v_today date;
  v_day date;
  v_state text;
begin
  if p_user_id is null or p_week_start is null
    or p_week_start <> date_trunc('week', p_week_start::timestamp)::date then return false; end if;
  select c.perfect_week_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  if not found then return false; end if;
  if p_week_start < v_policy_start then
    return exists (
      select 1 from public.progression_achievement_events e
      where e.user_id=p_user_id and e.achievement_id='perfect-week' and e.event_type='unlocked'
        and e.source_reference->>'week'=p_week_start::text
        and not exists(select 1 from public.progression_achievement_events r where r.user_id=e.user_id and r.reverses_event_id=e.id)
    ) and public.progression_perfect_week_qualifies_legacy(p_user_id,p_week_start,p_excluded_tracker_id);
  end if;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_timezone,v_today
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id=a.user_id
  where a.user_id=p_user_id;
  if not found then return false; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;
  if p_week_start + 6 >= v_today then return false; end if;
  v_day:=p_week_start;
  while v_day <= p_week_start + 6 loop
    if not public.progression_perfect_period_day_qualifies(p_user_id,v_day,p_excluded_tracker_id) then return false; end if;
    v_day:=v_day+1;
  end loop;
  return true;
end;
$$;
revoke all on function public.progression_perfect_week_qualifies(uuid,date,uuid) from public,anon,authenticated,service_role;
revoke all on function public.progression_perfect_week_qualifies_legacy(uuid,date,uuid) from public,anon,authenticated,service_role;

-- Replace only the new-policy month branch. Existing earned months are still
-- checked by the preserved legacy function before the policy cutover.
create or replace function public.progression_perfect_month_qualifies(
  p_user_id uuid, p_month_start date, p_excluded_tracker_id uuid default null
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_month_end date;
  v_today date;
  v_timezone text;
  v_policy_start date;
  v_state text;
  v_day date;
  v_event_exists boolean;
begin
  if p_user_id is null or p_month_start is null
    or p_month_start <> date_trunc('month',p_month_start::timestamp)::date then return false; end if;
  select c.perfect_month_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_timezone,v_today
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id=a.user_id
  where a.user_id=p_user_id;
  if not found then return false; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;
  v_month_end:=(p_month_start+interval '1 month'-interval '1 day')::date;
  if v_month_end >= v_today then return false; end if;
  if p_month_start < v_policy_start then
    select exists(select 1 from public.progression_achievement_events e
      where e.user_id=p_user_id and e.achievement_id='perfect-month' and e.event_type='unlocked'
        and e.source_reference->>'month'=to_char(p_month_start,'YYYY-MM')) into v_event_exists;
    return v_event_exists and public.progression_perfect_month_qualifies_legacy(p_user_id,p_month_start,p_excluded_tracker_id);
  end if;
  v_day:=p_month_start;
  while v_day<=v_month_end loop
    if not public.progression_perfect_period_day_qualifies(p_user_id,v_day,p_excluded_tracker_id) then return false; end if;
    v_day:=v_day+1;
  end loop;
  return true;
end;
$$;
revoke all on function public.progression_perfect_month_qualifies(uuid,date,uuid) from public,anon,authenticated,service_role;

create or replace function public.progression_perfect_year_qualifies(p_user_id uuid,p_year_start date)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy_start date;
  v_timezone text;
  v_today date;
  v_year_end date;
  v_day date;
begin
  if p_user_id is null or p_year_start is null
    or p_year_start<>date_trunc('year',p_year_start::timestamp)::date then return false; end if;
  select c.perfect_year_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  if not found or p_year_start<v_policy_start then return false; end if;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_timezone,v_today
  from public.progression_achievement_accounts a left join public.app_settings s on s.user_id=a.user_id
  where a.user_id=p_user_id;
  if not found then return false; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;
  v_year_end:=(p_year_start+interval '1 year'-interval '1 day')::date;
  if v_year_end>=v_today then return false; end if;
  v_day:=p_year_start;
  while v_day<=v_year_end loop
    if not public.progression_perfect_period_day_qualifies(p_user_id,v_day) then return false; end if;
    v_day:=v_day+1;
  end loop;
  return true;
end;
$$;
revoke all on function public.progression_perfect_year_qualifies(uuid,date) from public,anon,authenticated,service_role;

create or replace function public.progression_perfect_year_qualifies_excluding(p_user_id uuid,p_year_start date,p_excluded_tracker_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy_start date; v_timezone text; v_today date; v_year_end date; v_day date;
begin
  if p_user_id is null or p_year_start is null or p_year_start<>date_trunc('year',p_year_start::timestamp)::date then return false; end if;
  select c.perfect_year_start into v_policy_start from public.progression_policy_cutovers c where c.id;
  if not found or p_year_start<v_policy_start then return false; end if;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_timezone,v_today from public.progression_achievement_accounts a left join public.app_settings s on s.user_id=a.user_id where a.user_id=p_user_id;
  if not found then return false; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date; end if;
  v_year_end:=(p_year_start+interval '1 year'-interval '1 day')::date;
  if v_year_end>=v_today then return false; end if;
  v_day:=p_year_start;
  while v_day<=v_year_end loop
    if not public.progression_perfect_period_day_qualifies(p_user_id,v_day,p_excluded_tracker_id) then return false; end if;
    v_day:=v_day+1;
  end loop;
  return true;
end;
$$;
revoke all on function public.progression_perfect_year_qualifies_excluding(uuid,date,uuid) from public,anon,authenticated,service_role;

create or replace function public.reconcile_progression_perfect_years(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_policy_start date;
  v_timezone text;
  v_today date;
  v_year_start date;
  v_event public.progression_achievement_events%rowtype;
  v_new public.progression_achievement_events%rowtype;
  v_tier integer;
  v_generation integer;
begin
  if p_user_id is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':progression-achievements',11));
  select c.perfect_year_start,coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_policy_start,v_timezone,v_today
  from public.progression_achievement_accounts a cross join public.progression_policy_cutovers c
    left join public.app_settings s on s.user_id=a.user_id
  where a.user_id=p_user_id and c.id;
  if not found then return; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;

  for v_event in
    select u.* from public.progression_achievement_events u
    where u.user_id=p_user_id and u.achievement_id='perfect-year' and u.event_type='unlocked'
      and u.source_reference->>'year' ~ '^[0-9]{4}$'
      and (u.source_reference->>'year')::integer >= extract(year from v_policy_start)::integer
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
      and not exists(select 1 from public.progression_retained_achievement_unlocks k where k.user_id=u.user_id and k.achievement_event_id=u.id)
  loop
    v_year_start:=make_date((v_event.source_reference->>'year')::integer,1,1);
    if not public.progression_perfect_year_qualifies(p_user_id,v_year_start) then
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
      values(p_user_id,'perfect-year',v_event.tier,v_event.generation,'revoked',v_event.source_event_id,v_event.source_date,
        jsonb_build_object('reason','A historical correction changed a date in this calendar year'),'revoke:'||v_event.id::text,v_event.id)
      on conflict(user_id,idempotency_key) do nothing;
    end if;
  end loop;

  for v_year_start in
    select make_date(y,1,1) from generate_series(extract(year from v_policy_start)::integer,extract(year from v_today-1)::integer) y
    order by y
  loop
    if not public.progression_perfect_year_qualifies(p_user_id,v_year_start) then continue; end if;
    select u.* into v_event from public.progression_achievement_events u
    where u.user_id=p_user_id and u.achievement_id='perfect-year' and u.event_type='unlocked'
      and u.source_reference->>'year'=extract(year from v_year_start)::integer::text
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
    order by u.recorded_at desc limit 1;
    if v_event.id is null then
      select count(*)::integer into v_tier from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id='perfect-year' and u.event_type='unlocked'
        and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
      select coalesce(max(generation),0)+1 into v_generation from public.progression_achievement_events u
      where u.user_id=p_user_id and u.achievement_id='perfect-year'
        and u.source_reference->>'year'=extract(year from v_year_start)::integer::text;
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_date,source_reference,idempotency_key)
      values(p_user_id,'perfect-year',v_tier+1,v_generation,'unlocked',make_date(extract(year from v_year_start)::integer,12,31),
        jsonb_build_object('rule','Every date in the completed calendar year was a server-confirmed Perfect Day','year',extract(year from v_year_start)::integer),
        'perfect-year:'||extract(year from v_year_start)::integer::text||':unlock:'||v_generation)
      on conflict(user_id,idempotency_key) do nothing returning * into v_new;
      if v_new.id is not null then v_event:=v_new; end if;
    end if;
    if v_event.id is not null then
      delete from public.progression_achievement_event_sources s where s.user_id=p_user_id and s.achievement_event_id=v_event.id;
      insert into public.progression_achievement_event_sources(user_id,achievement_event_id,source_tracker_id,source_key)
      select p_user_id,v_event.id,t.id,'perfect-year:'||extract(year from v_year_start)::integer::text
      from public.trackers t
      where t.user_id=p_user_id and t.status in ('active','archived') and t.deleted_at is null
        and exists(select 1 from generate_series(v_year_start::timestamp,(v_year_start+interval '1 year'-interval '1 day')::timestamp,interval '1 day') d(day)
          where public.progression_date_is_eligible(p_user_id,t,d.day::date))
      on conflict do nothing;
    end if;
    v_event:=null;
  end loop;

  select count(*)::integer into v_tier from public.progression_achievement_events u
  where u.user_id=p_user_id and u.achievement_id='perfect-year' and u.event_type='unlocked'
    and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id);
  insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable)
  values(p_user_id,'perfect-year',v_tier,1,v_tier,true)
  on conflict(user_id,achievement_id) do update set progress=excluded.progress,target=1,current_tier=excluded.current_tier,
    repeatable=true,updated_at=clock_timestamp();
end;
$$;
revoke all on function public.reconcile_progression_perfect_years(uuid) from public,anon,authenticated,service_role;

create or replace function public.reconcile_progression_perfect_year_before_tracker_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event public.progression_achievement_events%rowtype; v_year_start date;
begin
  if new.wins_retention<>'delete_wins' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text||':progression-achievements',11));
  for v_event in
    select u.* from public.progression_achievement_events u
    join public.progression_achievement_event_sources s on s.user_id=u.user_id and s.achievement_event_id=u.id
    where u.user_id=new.user_id and u.achievement_id='perfect-year' and u.event_type='unlocked' and s.source_tracker_id=new.tracker_id
      and u.source_reference->>'year' ~ '^[0-9]{4}$'
      and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)
      and not exists(select 1 from public.progression_retained_achievement_unlocks k where k.user_id=u.user_id and k.achievement_event_id=u.id)
  loop
    v_year_start:=make_date((v_event.source_reference->>'year')::integer,1,1);
    if not public.progression_perfect_year_qualifies_excluding(new.user_id,v_year_start,new.tracker_id) then
      insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_event_id,source_date,source_reference,idempotency_key,reverses_event_id)
      values(new.user_id,'perfect-year',v_event.tier,v_event.generation,'revoked',v_event.source_event_id,v_event.source_date,
        jsonb_build_object('reason','The remaining trackers no longer qualify after Delete Tracker and Wins'),'revoke:'||v_event.id::text,v_event.id)
      on conflict(user_id,idempotency_key) do nothing;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_perfect_year_before_tracker_deletion() from public,anon,authenticated,service_role;
create trigger tracker_deletion_reconcile_perfect_year
before insert on public.tracker_deletion_ledger
for each row execute function public.reconcile_progression_perfect_year_before_tracker_deletion();

-- Publish truthful progress for the in-flight week, month, and year. A missed
-- day makes that period failed; unsupported schedule history is unavailable.
create or replace function public.refresh_progression_perfect_period_details(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_timezone text;
  v_today date;
  v_period record;
  v_day date;
  v_state text;
  v_count integer;
  v_status text;
  v_message text;
begin
  if p_user_id is null then return; end if;
  select coalesce(s.timezone,'UTC'),(clock_timestamp() at time zone coalesce(s.timezone,'UTC'))::date
    into v_timezone,v_today from public.progression_achievement_accounts a
    left join public.app_settings s on s.user_id=a.user_id where a.user_id=p_user_id;
  if not found then return; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone:='UTC'; v_today:=(clock_timestamp() at time zone 'UTC')::date;
  end if;
  for v_period in select * from (values
    ('perfect-week'::text,date_trunc('week',v_today::timestamp)::date,(date_trunc('week',v_today::timestamp)::date+6),7),
    ('perfect-month'::text,date_trunc('month',v_today::timestamp)::date,(date_trunc('month',v_today::timestamp)+interval '1 month'-interval '1 day')::date,extract(day from (date_trunc('month',v_today::timestamp)+interval '1 month'-interval '1 day'))::integer),
    ('perfect-year'::text,date_trunc('year',v_today::timestamp)::date,(date_trunc('year',v_today::timestamp)+interval '1 year'-interval '1 day')::date,(date_trunc('year',v_today::timestamp)+interval '1 year'-interval '1 day')::date-date_trunc('year',v_today::timestamp)::date+1)
  ) p(achievement_id,period_start,period_end,target)
  loop
    v_count:=0; v_status:='in_progress'; v_message:='Confirmed Perfect Days so far.';
    v_day:=v_period.period_start;
    while v_day<=least(v_period.period_end,v_today) loop
      v_state:=public.progression_evaluate_perfect_day(p_user_id,v_day);
      if v_state='unsupported' then v_status:='unavailable'; v_message:='This period includes dates without reliable schedule history.'; exit;
      elsif v_state='failed' or v_state='neutral' then v_status:='failed'; v_message:='A required date was not a Perfect Day. Qualification starts again next period.'; exit;
      elsif v_state='perfect' and public.progression_perfect_period_day_qualifies(p_user_id,v_day) then v_count:=v_count+1;
      elsif v_state='perfect' then v_status:='failed'; v_message:='No eligible positive target was confirmed on this date.'; exit;
      end if;
      v_day:=v_day+1;
    end loop;
    update public.progression_achievement_progress set qualification_details=jsonb_build_object(
      'status',v_status,'label',case v_period.achievement_id when 'perfect-week' then 'Current calendar week' when 'perfect-month' then 'Current calendar month' else 'Current calendar year' end,
      'period_start',v_period.period_start,'period_end',v_period.period_end,'progress',v_count,'target',v_period.target,
      'percentage',round(v_count::numeric/v_period.target*100,0),'message',v_message||' '||v_count::text||' of '||v_period.target::text||' dates confirmed.'),
      updated_at=clock_timestamp()
    where user_id=p_user_id and achievement_id=v_period.achievement_id;
  end loop;
end;
$$;
revoke all on function public.refresh_progression_perfect_period_details(uuid) from public,anon,authenticated,service_role;

alter function public.reconcile_progression_achievements(uuid)
  rename to reconcile_progression_achievements_before_strict_calendar_badges;
create function public.reconcile_progression_achievements(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.reconcile_progression_achievements_before_strict_calendar_badges(p_user_id);
  perform public.reconcile_progression_perfect_years(p_user_id);
  perform public.refresh_progression_perfect_period_details(p_user_id);
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public,anon,authenticated,service_role;

insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable)
select user_id,'perfect-year',0,1,0,true from public.progression_achievement_progress
where achievement_id='perfect-day'
on conflict(user_id,achievement_id) do nothing;

comment on function public.progression_perfect_week_qualifies(uuid,date,uuid) is
  'A completed Monday-based week qualifies only when all seven dates are server-confirmed Perfect Days using configured daily success rules.';
comment on function public.progression_perfect_month_qualifies(uuid,date,uuid) is
  'A completed month qualifies only when every date, using the actual calendar month length, is a server-confirmed Perfect Day.';
comment on function public.progression_perfect_year_qualifies(uuid,date) is
  'A completed calendar year qualifies only when every date, including leap day, is a server-confirmed Perfect Day.';

commit;
