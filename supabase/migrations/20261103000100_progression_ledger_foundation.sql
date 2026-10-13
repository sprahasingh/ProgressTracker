-- Private, append-only account score events. Source identities are stored
-- separately so permanent tracker deletion can anonymize history without
-- changing the score ledger itself.
begin;

create table public.progression_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_category text not null check (event_category in ('check_in', 'daily_bonus', 'streak_milestone', 'goal_milestone', 'goal_completed', 'legacy_opening_balance', 'reversal')),
  reason_code text not null check (reason_code in ('DAILY_CHECK_IN_COMPLETED', 'PERFECT_DAY_BONUS', 'STREAK_MILESTONE', 'GOAL_MILESTONE', 'GOAL_COMPLETED', 'LEGACY_XP_OPENING_BALANCE', 'AWARD_REVERSAL')),
  effective_date date not null,
  recorded_at timestamptz not null default clock_timestamp(),
  xp_delta integer not null,
  scoring_version smallint not null check (scoring_version > 0),
  idempotency_key uuid not null,
  reverses_event_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, idempotency_key),
  unique (user_id, id),
  constraint progression_reversal_shape check (
    (reason_code = 'AWARD_REVERSAL' and reverses_event_id is not null and xp_delta < 0)
    or (reason_code <> 'AWARD_REVERSAL' and reverses_event_id is null)
  ),
  constraint progression_reversal_owner_fk foreign key (user_id, reverses_event_id)
    references public.progression_events(user_id, id) on delete cascade
);

create index progression_events_user_recorded_idx
  on public.progression_events(user_id, recorded_at desc, id desc);
create index progression_events_user_effective_idx
  on public.progression_events(user_id, effective_date desc, id desc);
create unique index progression_one_legacy_opening_balance
  on public.progression_events(user_id)
  where reason_code = 'LEGACY_XP_OPENING_BALANCE';
create unique index progression_one_reversal_per_event
  on public.progression_events(user_id, reverses_event_id)
  where reverses_event_id is not null;

alter table public.progression_events enable row level security;
revoke all on public.progression_events from public, anon, authenticated;
grant select on public.progression_events to authenticated;
create policy progression_events_select_own on public.progression_events
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create table public.progression_event_sources (
  user_id uuid not null,
  event_id uuid not null,
  tracker_id uuid,
  goal_id uuid,
  source_id uuid,
  display_name text not null default 'Deleted tracker',
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, event_id),
  foreign key (user_id, event_id) references public.progression_events(user_id, id) on delete cascade,
  check (tracker_id is null or goal_id is null)
);
create index progression_event_sources_tracker_idx
  on public.progression_event_sources(user_id, tracker_id) where tracker_id is not null;
create index progression_event_sources_goal_idx
  on public.progression_event_sources(user_id, goal_id) where goal_id is not null;

alter table public.progression_event_sources enable row level security;
revoke all on public.progression_event_sources from public, anon, authenticated;
grant select on public.progression_event_sources to authenticated;
create policy progression_event_sources_select_own on public.progression_event_sources
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.anonymize_tracker_progression_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.progression_event_sources
  where user_id = old.user_id and tracker_id = old.id;
  return old;
end;
$$;
revoke all on function public.anonymize_tracker_progression_sources() from public, anon, authenticated;
create trigger trackers_anonymize_progression_sources
  before delete on public.trackers
  for each row execute function public.anonymize_tracker_progression_sources();

-- Translate the existing tracker completion rules to the trusted database
-- boundary. The client submits observations only; it never submits XP.
create or replace function public.progression_metric_level(p_definition jsonb, p_values jsonb, p_metric_id text)
returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  v_metric jsonb;
  v_value jsonb;
  v_progress numeric;
  v_direction text;
  v_level integer := 0;
begin
  select metric into v_metric
  from jsonb_array_elements(coalesce(p_definition->'metrics', '[]'::jsonb)) as metrics(metric)
  where metric->>'id' = p_metric_id and metric->>'retiredAt' is null
  limit 1;
  if v_metric is null then return 0; end if;
  v_value := p_values->p_metric_id;
  if v_value is null or v_value = 'null'::jsonb then return 0; end if;
  if v_metric->>'valueType' = 'boolean' then
    return case when v_value = 'true'::jsonb then 2 else 0 end;
  elsif v_metric->>'valueType' in ('quantity', 'duration') and jsonb_typeof(v_value) = 'number' then
    v_progress := (v_value #>> '{}')::numeric;
  elsif v_metric->>'valueType' = 'checklist' then
    if jsonb_typeof(v_value) = 'array' then
      select count(*) into v_progress from jsonb_array_elements(v_value) as items(item) where item = 'true'::jsonb;
    elsif jsonb_typeof(v_value) = 'object' then
      select count(*) into v_progress from jsonb_each(v_value) as items(key,value) where value = 'true'::jsonb;
    else return 0;
    end if;
  else
    return 0;
  end if;
  if v_progress is null then return 0; end if;
  v_direction := coalesce(v_metric->'thresholds'->>'direction', 'increase');
  if v_metric->'thresholds'->>'stretch' is not null and
     (case when v_direction = 'decrease' then v_progress <= (v_metric->'thresholds'->>'stretch')::numeric else v_progress >= (v_metric->'thresholds'->>'stretch')::numeric end) then return 3; end if;
  if v_metric->'thresholds'->>'target' is not null and
     (case when v_direction = 'decrease' then v_progress <= (v_metric->'thresholds'->>'target')::numeric else v_progress >= (v_metric->'thresholds'->>'target')::numeric end) then return 2; end if;
  if v_metric->'thresholds'->>'minimum' is not null and
     (case when v_direction = 'decrease' then v_progress <= (v_metric->'thresholds'->>'minimum')::numeric else v_progress >= (v_metric->'thresholds'->>'minimum')::numeric end) then return 1; end if;
  if v_metric->'thresholds' is null and v_progress > 0 then return 2; end if;
  return v_level;
end;
$$;
revoke all on function public.progression_metric_level(jsonb,jsonb,text) from public, anon, authenticated;

create or replace function public.progression_rule_qualifies(p_definition jsonb, p_values jsonb, p_rule jsonb)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_count integer;
  v_metric jsonb;
  v_value jsonb;
  v_expected jsonb;
  v_operator text;
  v_threshold integer;
begin
  case p_rule->>'kind'
    when 'all' then
      select count(*) into v_count from jsonb_array_elements(coalesce(p_rule->'operands','[]'::jsonb)) as operands(operand)
      where not public.progression_rule_qualifies(p_definition,p_values,operand);
      return v_count = 0;
    when 'any' then
      select count(*) into v_count from jsonb_array_elements(coalesce(p_rule->'operands','[]'::jsonb)) as operands(operand)
      where public.progression_rule_qualifies(p_definition,p_values,operand);
      return v_count > 0;
    when 'at-least' then
      select count(*) into v_count from jsonb_array_elements(coalesce(p_rule->'operands','[]'::jsonb)) as operands(operand)
      where public.progression_rule_qualifies(p_definition,p_values,operand);
      return v_count >= coalesce((p_rule->>'required')::integer, 2147483647);
    when 'threshold' then
      v_threshold := case p_rule->>'level' when 'minimum' then 1 when 'target' then 2 when 'stretch' then 3 else 2147483647 end;
      return public.progression_metric_level(p_definition,p_values,p_rule->>'metricId') >= v_threshold;
    when 'comparison' then
      select metric into v_metric from jsonb_array_elements(coalesce(p_definition->'metrics','[]'::jsonb)) as metrics(metric)
        where metric->>'id' = p_rule->>'metricId' and metric->>'retiredAt' is null limit 1;
      v_value := p_values->(p_rule->>'metricId');
      v_expected := p_rule->'value';
      v_operator := p_rule->>'operator';
      if v_metric is null or v_value is null or v_value = 'null'::jsonb then return false; end if;
      if jsonb_typeof(v_value) = 'number' and jsonb_typeof(v_expected) = 'number' then
        return case v_operator when 'equals' then (v_value #>> '{}')::numeric = (v_expected #>> '{}')::numeric
          when 'at-least' then (v_value #>> '{}')::numeric >= (v_expected #>> '{}')::numeric
          when 'at-most' then (v_value #>> '{}')::numeric <= (v_expected #>> '{}')::numeric else false end;
      end if;
      return v_operator = 'equals' and v_value = v_expected;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_rule_qualifies(jsonb,jsonb,jsonb) from public, anon, authenticated;

create or replace function public.progression_entry_qualifies(p_definition jsonb, p_values jsonb, p_outcome text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_rule jsonb := p_definition->'qualificationRule';
  v_metric jsonb;
  v_level integer;
  v_required integer;
  v_value jsonb;
  v_progress numeric;
begin
  if p_outcome <> 'recorded' then return false; end if;
  if v_rule is not null and jsonb_typeof(v_rule) = 'object' then
    return public.progression_rule_qualifies(p_definition,p_values,v_rule);
  end if;
  select metric into v_metric from jsonb_array_elements(coalesce(p_definition->'metrics','[]'::jsonb)) with ordinality as metrics(metric,position)
    where metric->>'retiredAt' is null order by position limit 1;
  if v_metric is null then return false; end if;
  v_value := p_values->(v_metric->>'id');
  if v_value is null or v_value = 'null'::jsonb then return false; end if;
  v_level := public.progression_metric_level(p_definition,p_values,v_metric->>'id');
  case coalesce(v_metric->'thresholds'->>'streakQualification','any-recorded-value')
    when 'target' then return v_level >= 2;
    when 'minimum' then return v_level >= 1;
    else
      if v_metric->>'valueType' = 'boolean' then return v_value = 'true'::jsonb; end if;
      if v_metric->>'valueType' in ('quantity','duration') and jsonb_typeof(v_value) = 'number' then
        return (v_value #>> '{}')::numeric > 0;
      end if;
      if v_metric->>'valueType' = 'checklist' then
        if jsonb_typeof(v_value) = 'array' then
          select count(*) into v_required from jsonb_array_elements(v_value) as items(item) where item = 'true'::jsonb;
        elsif jsonb_typeof(v_value) = 'object' then
          select count(*) into v_required from jsonb_each(v_value) as items(key,value) where value = 'true'::jsonb;
        else return false;
        end if;
        return v_required > 0;
      end if;
      return false;
  end case;
end;
$$;
revoke all on function public.progression_entry_qualifies(jsonb,jsonb,text) from public, anon, authenticated;

create or replace function public.progression_date_is_eligible(p_user_id uuid, p_tracker public.trackers, p_date date)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_definition jsonb := p_tracker.definition;
  v_schedule jsonb := p_tracker.definition->'schedule';
  v_zone text;
  v_anchor date;
  v_weekday integer;
  v_day integer;
  v_month_days integer;
  v_count integer;
  v_interval integer;
begin
  select coalesce(timezone,'UTC') into v_zone from public.app_settings where user_id = p_user_id;
  v_zone := coalesce(v_zone,'UTC');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then v_zone := 'UTC'; end if;
  v_anchor := greatest(coalesce((v_definition->>'startDate')::date, (p_tracker.created_at at time zone v_zone)::date), (p_tracker.created_at at time zone v_zone)::date);
  if p_date < v_anchor or (p_tracker.definition->>'deadline' is not null and p_date > (p_tracker.definition->>'deadline')::date) then return false; end if;
  if coalesce((v_definition->>'strictMode')::boolean,false) then return true; end if;
  if exists(select 1 from public.account_holidays h where h.user_id=p_user_id and h.holiday_date=p_date and h.deleted_at is null) then return false; end if;
  v_weekday := extract(dow from p_date)::integer;
  v_day := extract(day from p_date)::integer;
  v_month_days := extract(day from (date_trunc('month',p_date::timestamp) + interval '1 month' - interval '1 day'))::integer;
  case v_schedule->>'kind'
    when 'every-day' then return true;
    when 'weekdays' then return v_weekday between 1 and 5;
    when 'selected-weekdays' then return coalesce(v_schedule->'weekdays','[]'::jsonb) @> to_jsonb(v_weekday);
    when 'every-n-days' then
      v_interval := greatest(coalesce((v_schedule->>'interval')::integer,0),0);
      return v_interval > 0 and mod(p_date-v_anchor,v_interval)=0;
    when 'times-per-week' then
      if v_schedule ? 'preferredWeekdays' then return coalesce(v_schedule->'preferredWeekdays','[]'::jsonb) @> to_jsonb(v_weekday); end if;
      v_count := coalesce((v_schedule->>'count')::integer,0);
      return v_count > 0 and floor((v_weekday+1)*v_count/7.0)>floor(v_weekday*v_count/7.0);
    when 'times-per-month' then
      v_count := coalesce((v_schedule->>'count')::integer,0);
      return v_count > 0 and floor(v_day*v_count::numeric/v_month_days)>floor((v_day-1)*v_count::numeric/v_month_days);
    when 'specific-dates' then return coalesce(v_schedule->'dates','[]'::jsonb) @> to_jsonb(p_date::text);
    when 'once' then return (v_schedule->>'date')::date = p_date;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_date_is_eligible(uuid,public.trackers,date) from public, anon, authenticated;

create or replace function public.record_progression_entry_award(p_user_id uuid,p_tracker_id uuid,p_entry_id uuid,p_entry_date date,p_values jsonb,p_outcome text,p_deleted_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_key uuid := md5(p_user_id::text||':'||p_entry_id::text||':daily-check-in-v1')::uuid;
  v_event public.progression_events%rowtype;
  v_reversal public.progression_events%rowtype;
  v_qualifies boolean := false;
begin
  select * into v_tracker from public.trackers where user_id=p_user_id and id=p_tracker_id;
  if not found then return; end if;
  v_qualifies := p_deleted_at is null
    and public.progression_date_is_eligible(p_user_id,v_tracker,p_entry_date)
    and public.progression_entry_qualifies(v_tracker.definition,p_values,p_outcome);
  select * into v_event from public.progression_events where user_id=p_user_id and idempotency_key=v_key;
  if v_qualifies and not found then
    insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
      values(p_user_id,'check_in','DAILY_CHECK_IN_COMPLETED',p_entry_date,10,1,v_key,jsonb_build_object('rule','10 XP per eligible completed check-in'))
      returning * into v_event;
    insert into public.progression_event_sources(user_id,event_id,tracker_id,source_id,display_name)
      values(p_user_id,v_event.id,p_tracker_id,p_entry_id,v_tracker.name);
  elsif not v_qualifies and found then
    select * into v_reversal from public.progression_events where user_id=p_user_id and reverses_event_id=v_event.id;
    if not found then
      insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,reverses_event_id,metadata)
        values(p_user_id,'reversal','AWARD_REVERSAL',p_entry_date,-v_event.xp_delta,1,md5('reverse:'||v_event.id::text)::uuid,v_event.id,jsonb_build_object('reason','Source check-in no longer qualifies'))
        returning * into v_reversal;
      insert into public.progression_event_sources(user_id,event_id,tracker_id,source_id,display_name)
        values(p_user_id,v_reversal.id,p_tracker_id,p_entry_id,v_tracker.name);
    end if;
  end if;
end;
$$;
revoke all on function public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz) from public, anon, authenticated;

create or replace function public.reconcile_progression_entry_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_progression_entry_award(new.user_id,new.tracker_id,new.id,new.entry_date,new.entry_values,new.outcome,new.deleted_at);
  return new;
end;
$$;
revoke all on function public.reconcile_progression_entry_trigger() from public, anon, authenticated;
create trigger tracker_entries_progression_award
  after insert or update of tracker_id, entry_date, outcome, entry_values, deleted_at on public.tracker_entries
  for each row execute function public.reconcile_progression_entry_trigger();

create or replace function public.reconcile_progression_tracker_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.tracker_entries%rowtype;
begin
  for v_entry in select * from public.tracker_entries where user_id=new.user_id and tracker_id=new.id loop
    perform public.record_progression_entry_award(v_entry.user_id,v_entry.tracker_id,v_entry.id,v_entry.entry_date,v_entry.entry_values,v_entry.outcome,v_entry.deleted_at);
  end loop;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_tracker_trigger() from public, anon, authenticated;
create trigger trackers_progression_definition_changed
  after update of definition on public.trackers
  for each row when (old.definition is distinct from new.definition)
  execute function public.reconcile_progression_tracker_trigger();

comment on table public.progression_events is
  'Account-scoped score history. Rows are written only by trusted database routines and removed only by account deletion cascade.';
comment on table public.progression_event_sources is
  'Private, erasable event associations. Rows are removed when a related tracker is permanently deleted; no notes or tracker payloads are stored.';
comment on column public.progression_events.metadata is
  'Structured scoring inputs only. Must not contain tracker names, notes, or user-authored content.';

commit;
