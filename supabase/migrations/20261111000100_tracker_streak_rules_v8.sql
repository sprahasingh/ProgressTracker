-- Persist explicit streak rules while retaining v1-v7 tracker definitions and
-- their legacy streak interpretation. Success rewards and streak rewards are
-- reconciled independently through the existing award ledger.
begin;

alter table public.trackers drop constraint if exists trackers_schema_version_check;
alter table public.trackers add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5, 6, 7, 8));

-- Rows already present at account cutover contributed to the opaque opening
-- XP estimate. Keep their stable IDs so later rule edits cannot grant their
-- historical rewards a second time. New backfilled rows remain individually
-- attributable and can use their activity dates.
create table public.progression_historical_entry_baseline (
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (user_id, entry_id)
);
alter table public.progression_historical_entry_baseline enable row level security;
revoke all on public.progression_historical_entry_baseline from public, anon, authenticated, service_role;
insert into public.progression_historical_entry_baseline(user_id, entry_id, captured_at)
select e.user_id, e.id, a.initialized_at
from public.tracker_entries e
join public.progression_account_state a on a.user_id = e.user_id
where e.server_changed_at < a.initialized_at
on conflict (user_id, entry_id) do nothing;

-- Future account initialization must mark the exact source rows included in
-- its opening estimate, including historical dates earlier than cutover day.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.initialize_progression_account(uuid)'::regprocedure);
  v_old text := '  insert into public.progression_account_state(user_id, initialized_at, scoring_version, legacy_xp_kind)';
  v_new text := $new$  insert into public.progression_historical_entry_baseline(user_id, entry_id, captured_at)
  select e.user_id, e.id, v_initialized_at
  from public.tracker_entries e
  where e.user_id = p_user_id and e.server_changed_at < v_initialized_at
  on conflict (user_id, entry_id) do nothing;

  insert into public.progression_account_state(user_id, initialized_at, scoring_version, legacy_xp_kind)$new$;
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected progression opening-balance marker was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

create or replace function public.tracker_rule_is_valid(p_definition jsonb, p_rule jsonb)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_kind text;
  v_metric jsonb;
  v_value jsonb;
  v_level text;
  v_number numeric;
  v_increment numeric;
  v_operator text;
  v_count integer;
  v_required integer;
  v_valid boolean;
begin
  if jsonb_typeof(p_rule) <> 'object' then return false; end if;
  v_kind := p_rule->>'kind';
  if v_kind in ('all', 'any', 'at-least') then
    if jsonb_typeof(p_rule->'operands') <> 'array' then return false; end if;
    select count(*)::integer, coalesce(bool_and(public.tracker_rule_is_valid(p_definition, operand)), false)
      into v_count, v_valid
    from jsonb_array_elements(p_rule->'operands') as rules(operand);
    if v_kind in ('all', 'any') and v_count < 2 then return false; end if;
    if v_kind = 'at-least' then
      if v_count < 1 or coalesce((p_rule->>'required')::integer, 0) < 1
        or (p_rule->>'required')::integer > v_count then return false; end if;
    end if;
    return v_valid;
  end if;

  select metric into v_metric
  from jsonb_array_elements(coalesce(p_definition->'metrics', '[]'::jsonb)) as metrics(metric)
  where metric->>'id' = p_rule->>'metricId' and metric->>'retiredAt' is null
  limit 1;
  if v_metric is null then return false; end if;

  if v_kind = 'threshold' then
    v_level := p_rule->>'level';
    if v_level not in ('minimum', 'target', 'stretch')
      or v_metric->'thresholds'->v_level is null
      or jsonb_typeof(v_metric->'thresholds'->v_level) <> 'number' then return false; end if;
    v_number := (v_metric->'thresholds'->>v_level)::numeric;
    if v_number < 0 then return false; end if;
    if v_metric->>'valueType' = 'boolean' then return false; end if;
    if v_metric->>'valueType' = 'checklist' then
      if trunc(v_number) <> v_number then return false; end if;
      if jsonb_typeof(v_metric->'checklistItems') <> 'array'
        or v_number > jsonb_array_length(v_metric->'checklistItems') then return false; end if;
    end if;
    v_increment := nullif(v_metric->'precision'->>'increment', '')::numeric;
    if v_increment is not null and mod(v_number, v_increment) <> 0 then return false; end if;
    if v_number = 0 and coalesce(v_metric->'thresholds'->>'direction', 'increase') = 'increase'
      and v_metric->>'valueType' <> 'boolean' then return false; end if;
    return true;
  end if;

  if v_kind <> 'comparison' then return false; end if;
  v_operator := p_rule->>'operator';
  v_value := p_rule->'value';
  if v_metric->>'valueType' = 'boolean' then
    return v_operator = 'equals' and jsonb_typeof(v_value) = 'boolean';
  end if;
  if v_metric->>'valueType' not in ('quantity', 'duration', 'checklist')
    or jsonb_typeof(v_value) <> 'number'
    or v_operator not in ('equals', 'at-least', 'at-most') then return false; end if;
  v_number := (v_value #>> '{}')::numeric;
  if v_number < 0 or (v_operator = 'at-least' and v_number = 0) then return false; end if;
  if v_metric->>'valueType' = 'checklist' then
    if trunc(v_number) <> v_number or jsonb_typeof(v_metric->'checklistItems') <> 'array'
      or v_number > jsonb_array_length(v_metric->'checklistItems') then return false; end if;
  end if;
  v_increment := nullif(v_metric->'precision'->>'increment', '')::numeric;
  if v_increment is not null and mod(v_number, v_increment) <> 0 then return false; end if;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public.tracker_rule_is_valid(jsonb, jsonb) from public, anon, authenticated, service_role;

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
  v_progress numeric;
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
      if v_metric->>'valueType' = 'checklist' then
        if jsonb_typeof(v_value) = 'array' then
          select count(*) into v_progress from jsonb_array_elements(v_value) as items(item) where item = 'true'::jsonb;
        elsif jsonb_typeof(v_value) = 'object' then
          select count(*) into v_progress from jsonb_each(v_value) as items(key,value) where value = 'true'::jsonb;
        else return false; end if;
        if jsonb_typeof(v_expected) <> 'number' then return false; end if;
        v_progress := case v_operator when 'equals' then case when v_progress = (v_expected #>> '{}')::numeric then 1 else 0 end
          when 'at-least' then case when v_progress >= (v_expected #>> '{}')::numeric then 1 else 0 end
          when 'at-most' then case when v_progress <= (v_expected #>> '{}')::numeric then 1 else 0 end else 0 end;
        return v_progress = 1;
      end if;
      if jsonb_typeof(v_value) = 'number' and jsonb_typeof(v_expected) = 'number' then
        return case v_operator when 'equals' then (v_value #>> '{}')::numeric = (v_expected #>> '{}')::numeric
          when 'at-least' then (v_value #>> '{}')::numeric >= (v_expected #>> '{}')::numeric
          when 'at-most' then (v_value #>> '{}')::numeric <= (v_expected #>> '{}')::numeric else false end;
      end if;
      return v_metric->>'valueType' = 'boolean' and v_operator = 'equals' and v_value = v_expected;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_rule_qualifies(jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;

create or replace function public.progression_entry_streak_qualifies(
  p_definition jsonb, p_values jsonb, p_outcome text
)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_mode text := p_definition->>'streakRuleMode';
  v_rule jsonb := p_definition->'streakRule';
begin
  if p_outcome <> 'recorded' then return false; end if;
  if v_mode = 'same-as-success' then
    return public.progression_entry_success_qualifies(p_definition, p_values, p_outcome);
  end if;
  if v_mode = 'custom' then
    return jsonb_typeof(v_rule) = 'object'
      and public.progression_rule_qualifies(p_definition, p_values, v_rule);
  end if;
  -- Missing mode is the v1-v7 compatibility path.
  return public.progression_entry_qualifies(p_definition, p_values, p_outcome);
end;
$$;
revoke all on function public.progression_entry_streak_qualifies(jsonb, jsonb, text) from public, anon, authenticated, service_role;

-- A source created after account initialization can legitimately be entered
-- for an earlier activity date. Sources captured in the opening estimate stay
-- protected, while post-cutover sources use the same stable award identity.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure);
  v_old text := 'if v_historic and v_state.current_xp = 0 then v_qualifies := false; end if;';
  v_new text := 'if v_historic and v_state.current_xp = 0 and exists (' ||
    'select 1 from public.progression_historical_entry_baseline b ' ||
    'where b.user_id = p_user_id and b.entry_id = p_entry_id' ||
    ') then v_qualifies := false; end if;';
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected historical entry cutover guard was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

alter table public.trackers add constraint trackers_streak_rule_v8_check check (
  case when schema_version < 8 then
    not (definition ? 'streakRuleMode') and not (definition ? 'streakRule')
  else
    case definition->>'streakRuleMode'
      when 'same-as-success' then not (definition ? 'streakRule')
        and (not (definition ? 'qualificationRule') or public.tracker_rule_is_valid(definition, definition->'qualificationRule'))
      when 'custom' then definition ? 'streakRule'
        and public.tracker_rule_is_valid(definition, definition->'streakRule')
        and (not (definition ? 'qualificationRule') or public.tracker_rule_is_valid(definition, definition->'qualificationRule'))
      else false
    end
  end
);

create or replace function public.prevent_tracker_schema_downgrade()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.schema_version < old.schema_version then
    raise exception 'tracker schema version cannot be downgraded from % to %', old.schema_version, new.schema_version
      using errcode = '23514';
  end if;
  if new.schema_version = 7
     and new.definition->'scheduling'->>'mode' = 'effective'
     and coalesce(new.definition->'scheduling'->>'effectiveDayCounting', '') not in ('planned-activity-days', 'all-non-holiday-days') then
    raise exception 'schema v7 Effective Days requires an explicit supported counting method'
      using errcode = '23514';
  end if;
  if new.schema_version = 8 and new.definition->>'streakRuleMode' not in ('same-as-success', 'custom') then
    raise exception 'schema v8 requires a supported streak rule mode'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_tracker_schema_downgrade() from public, anon, authenticated;

-- Daily success XP uses Success Rule qualification. Tracker milestone and
-- streak-history calculations use the separate Streak Rule function.
do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure);
  v_old := 'public.progression_entry_qualifies(v_tracker.definition, p_values, p_outcome)';
  v_new := 'public.progression_entry_success_qualifies(v_tracker.definition, p_values, p_outcome)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected daily XP qualification call was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);

  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_tracker_milestones(uuid,uuid)'::regprocedure);
  v_old := 'public.progression_entry_qualifies(v_tracker.definition, entry.entry_values, entry.outcome)';
  v_new := 'public.progression_entry_streak_qualifies(v_tracker.definition, entry.entry_values, entry.outcome)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected tracker streak-milestone qualification call was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := 'greatest(coalesce((v_tracker.definition->>''startDate'')::date, (v_tracker.created_at at time zone v_timezone)::date), (v_tracker.created_at at time zone v_timezone)::date, (v_cutover_at at time zone v_timezone)::date)';
  v_new := 'coalesce((v_tracker.definition->>''startDate'')::date, (v_tracker.created_at at time zone v_timezone)::date)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected tracker streak history boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := 'where public.progression_date_is_eligible(p_user_id, v_tracker, days.activity_at::date)';
  v_new := 'where public.progression_date_is_eligible(p_user_id, v_tracker, days.activity_at::date)' ||
    ' and (days.activity_at::date >= (v_cutover_at at time zone v_timezone)::date or not exists (' ||
    'select 1 from public.progression_historical_entry_baseline b ' ||
    'where b.user_id = p_user_id and b.entry_id = entry.id))';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected tracker milestone schedule filter was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := 'and v_crossed_date >= (v_cutover_at at time zone v_timezone)::date';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected tracker milestone cutover date guard was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, '');

  v_definition := pg_catalog.pg_get_functiondef('public.progression_evaluate_account_day(uuid,date,uuid)'::regprocedure);
  v_old := 'public.progression_entry_qualifies(';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected account streak qualification calls were not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, 'public.progression_entry_streak_qualifies(');

  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  v_old := 'public.progression_entry_qualifies(t.definition, e.entry_values, e.outcome)) as qualifies';
  v_new := 'public.progression_entry_streak_qualifies(t.definition, e.entry_values, e.outcome)) as qualifies';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected achievement streak qualification call was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := 'public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)))::integer as completed_count';
  v_new := 'public.progression_entry_success_qualifies(t.definition,e.entry_values,e.outcome)))::integer as completed_count';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected success consistency qualification call was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := $old$  select greatest((v_cutover at time zone v_timezone)::date,
      coalesce(max(t.updated_at at time zone v_timezone)::date, (v_cutover at time zone v_timezone)::date))
    into v_start_date
    from public.trackers t where t.user_id = p_user_id and t.status in ('active','archived') and t.deleted_at is null;$old$;
  v_new := $new$  select least(
      greatest((v_cutover at time zone v_timezone)::date,
        coalesce(max(t.updated_at at time zone v_timezone)::date, (v_cutover at time zone v_timezone)::date)),
      coalesce((select min(e.entry_date) from public.tracker_entries e
        where e.user_id = p_user_id and e.deleted_at is null and e.server_changed_at >= v_cutover
          and not exists(select 1 from public.progression_historical_entry_baseline b
            where b.user_id = e.user_id and b.entry_id = e.id)),
        greatest((v_cutover at time zone v_timezone)::date,
          coalesce(max(t.updated_at at time zone v_timezone)::date, (v_cutover at time zone v_timezone)::date)))
    )
    into v_start_date
    from public.trackers t where t.user_id = p_user_id and t.status in ('active','archived') and t.deleted_at is null;$new$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected achievement history boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := 'and e.server_changed_at>=v_cutover';
  v_new := 'and e.server_changed_at>=v_cutover and (e.entry_date >= (v_cutover at time zone v_timezone)::date or not exists(' ||
    'select 1 from public.progression_historical_entry_baseline b where b.user_id=e.user_id and b.entry_id=e.id))';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected historical achievement source filter was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_repeatable_achievements(uuid)'::regprocedure);
  v_old := 'public.progression_entry_qualifies(t.definition,e.entry_values,e.outcome)) qualifies';
  v_new := 'public.progression_entry_streak_qualifies(t.definition,e.entry_values,e.outcome)) qualifies';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected repeatable streak achievement qualification call was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

comment on column public.trackers.schema_version is
  'Tracker definition versions through v8; v8 persists an independent streak rule and preserves versions v1-v7.';
comment on function public.progression_entry_streak_qualifies(jsonb, jsonb, text) is
  'Evaluates explicit v8 streak rules while preserving the established streak behavior for tracker definitions through v7.';
comment on function public.tracker_rule_is_valid(jsonb, jsonb) is
  'Validates tracker-rule structure and measure-aware comparison values at the server sync boundary.';

commit;
