-- Store date-effective tracker evaluation snapshots inside the owner-scoped
-- tracker definition. This keeps rule history atomic with the existing tracker
-- revision and avoids a data backfill or a progression-trigger storm.
begin;

alter table public.trackers drop constraint if exists trackers_schema_version_check;
alter table public.trackers add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10));

alter table public.trackers drop constraint if exists trackers_rule_versions_v10_check;
alter table public.trackers add constraint trackers_rule_versions_v10_check check (
  case
    when schema_version < 10 then not (definition ? 'ruleVersions')
    else case
      when jsonb_typeof(definition->'ruleVersions') = 'array'
        then jsonb_array_length(definition->'ruleVersions') > 0
      else false
    end
  end
);

-- Expand the existing server-side v9 milestone validator to v10 definitions.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.prevent_tracker_schema_downgrade()'::regprocedure);
  v_updated text;
begin
  v_updated := pg_catalog.replace(v_definition, 'if new.schema_version = 9 then', 'if new.schema_version in (9, 10) then');
  if v_updated = v_definition then
    raise exception 'The v9 tracker definition guard no longer has its expected milestone boundary';
  end if;
  execute v_updated;
end;
$$;

create or replace function public.progression_tracker_definition_for_date(p_definition jsonb, p_date date)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_definition || coalesce((
    select version.value->'evaluation'
    from jsonb_array_elements(coalesce(p_definition->'ruleVersions', '[]'::jsonb)) with ordinality as version(value, position)
    where (version.value->>'effectiveFrom')::date <= p_date
    order by (version.value->>'effectiveFrom')::date desc, version.position desc
    limit 1
  ), '{}'::jsonb)
$$;
revoke all on function public.progression_tracker_definition_for_date(jsonb, date) from public, anon, authenticated, service_role;

create or replace function public.progression_tracker_date_in_period(
  p_definition jsonb, p_created_at timestamptz, p_date date, p_timezone text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_date >= coalesce(
      (public.progression_tracker_definition_for_date(p_definition, p_date)->>'startDate')::date,
      (p_created_at at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::date
    )
    and (public.progression_tracker_definition_for_date(p_definition, p_date)->>'deadline' is null
      or p_date <= (public.progression_tracker_definition_for_date(p_definition, p_date)->>'deadline')::date)
$$;
revoke all on function public.progression_tracker_date_in_period(jsonb, timestamptz, date, text) from public, anon, authenticated, service_role;

create or replace function public.progression_tracker_history_start_date(
  p_definition jsonb, p_created_at timestamptz, p_timezone text
)
returns date
language sql
stable
set search_path = ''
as $$
  select min(coalesce(
    (evaluation->>'startDate')::date,
    (p_created_at at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::date
  ))
  from (
    select p_definition as evaluation
    union all
    select version.value->'evaluation'
    from jsonb_array_elements(coalesce(p_definition->'ruleVersions', '[]'::jsonb)) as version(value)
  ) as evaluations
$$;
revoke all on function public.progression_tracker_history_start_date(jsonb, timestamptz, text) from public, anon, authenticated, service_role;

create or replace function public.progression_tracker_evaluation_signature(p_evaluation jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with recursive rule_nodes(node) as (
    select p_evaluation->'qualificationRule'
    where jsonb_typeof(p_evaluation->'qualificationRule') = 'object'
    union all
    select p_evaluation->'streakRule'
    where p_evaluation->>'streakRuleMode' = 'custom'
      and jsonb_typeof(p_evaluation->'streakRule') = 'object'
    union all
    select operand.value
    from rule_nodes parent
    cross join lateral jsonb_array_elements(coalesce(parent.node->'operands', '[]'::jsonb)) as operand(value)
  ), fallback_metric(metric_id) as (
    select metric.value->>'id'
    from jsonb_array_elements(coalesce(p_evaluation->'metrics', '[]'::jsonb)) with ordinality as metric(value, position)
    where jsonb_typeof(p_evaluation->'qualificationRule') is distinct from 'object'
      and metric.value->'retiredAt' is null
    order by metric.position
    limit 1
  ), referenced_metrics(metric_id) as (
    select distinct node->>'metricId'
    from rule_nodes
    where node->>'kind' in ('threshold', 'comparison')
    union
    select metric_id from fallback_metric
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'schedule', p_evaluation->'schedule',
    'startDate', p_evaluation->'startDate',
    'deadline', p_evaluation->'deadline',
    'scheduling', p_evaluation->'scheduling',
    'metrics', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', metric.value->'id',
        'valueType', metric.value->'valueType',
        'unit', metric.value->'unit',
        'thresholds', metric.value->'thresholds',
        'checklistItems', case when jsonb_typeof(metric.value->'checklistItems') = 'array' then (
          select coalesce(jsonb_agg(item.value->'id' order by item.value->>'id'), '[]'::jsonb)
          from jsonb_array_elements(metric.value->'checklistItems') as item(value)
        ) else null end
      )) order by metric.value->>'id')
      from jsonb_array_elements(coalesce(p_evaluation->'metrics', '[]'::jsonb)) as metric(value)
      where metric.value->>'id' in (select metric_id from referenced_metrics)
    ), '[]'::jsonb),
    'qualificationRule', p_evaluation->'qualificationRule',
    'streakRuleMode', p_evaluation->'streakRuleMode',
    'streakRule', p_evaluation->'streakRule',
    'strictMode', p_evaluation->'strictMode'
  ))
$$;
revoke all on function public.progression_tracker_evaluation_signature(jsonb) from public, anon, authenticated, service_role;

-- All recurring progression calculations route through this single date-aware
-- eligibility function, including daily XP, streaks, Perfect Days, and badges.
create or replace function public.progression_date_is_eligible(
  p_user_id uuid, p_tracker public.trackers, p_date date
)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_definition jsonb;
  v_schedule jsonb;
  v_zone text;
  v_created_local_date date;
  v_anchor date;
  v_weekday integer;
  v_day integer;
  v_month_days integer;
  v_count integer;
  v_interval integer;
begin
  select s.timezone into v_zone
  from public.app_settings s
  where s.user_id = p_user_id and s.timezone_configured;
  if not found or v_zone is null then return false; end if;
  begin
    v_created_local_date := (p_tracker.created_at at time zone v_zone)::date;
  exception when invalid_parameter_value then
    return false;
  end;
  v_definition := public.progression_tracker_definition_for_date(p_tracker.definition, p_date);
  v_schedule := v_definition->'schedule';
  v_anchor := coalesce((v_definition->>'startDate')::date, v_created_local_date);
  if v_anchor is null or p_date < v_anchor
    or (v_definition->>'deadline' is not null and p_date > (v_definition->>'deadline')::date) then return false; end if;
  if coalesce((v_definition->>'strictMode')::boolean, false) then return true; end if;
  if exists(select 1 from public.account_holidays h where h.user_id = p_user_id and h.holiday_date = p_date and h.deleted_at is null) then return false; end if;
  v_weekday := extract(dow from p_date)::integer;
  v_day := extract(day from p_date)::integer;
  v_month_days := extract(day from (date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day'))::integer;
  case v_schedule->>'kind'
    when 'every-day' then return true;
    when 'weekdays' then return v_weekday between 1 and 5;
    when 'selected-weekdays' then return coalesce(v_schedule->'weekdays', '[]'::jsonb) @> to_jsonb(v_weekday);
    when 'every-n-days' then
      v_interval := greatest(coalesce((v_schedule->>'interval')::integer, 0), 0);
      return v_interval > 0 and mod(p_date - v_anchor, v_interval) = 0;
    when 'times-per-week' then
      if v_schedule ? 'preferredWeekdays' then return coalesce(v_schedule->'preferredWeekdays', '[]'::jsonb) @> to_jsonb(v_weekday); end if;
      v_count := coalesce((v_schedule->>'count')::integer, 0);
      return v_count > 0 and floor((v_weekday + 1) * v_count / 7.0) > floor(v_weekday * v_count / 7.0);
    when 'times-per-month' then
      v_count := coalesce((v_schedule->>'count')::integer, 0);
      return v_count > 0 and floor(v_day * v_count::numeric / v_month_days) > floor((v_day - 1) * v_count::numeric / v_month_days);
    when 'specific-dates' then return coalesce(v_schedule->'dates', '[]'::jsonb) @> to_jsonb(p_date::text);
    when 'once' then return (v_schedule->>'date')::date = p_date;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_date_is_eligible(uuid, public.trackers, date) from public, anon, authenticated;

create or replace function public.progression_goal_milestone_entry_eligible(
  p_user_id uuid,
  p_tracker public.trackers,
  p_entry public.tracker_entries,
  p_cutover timestamptz,
  p_timezone text,
  p_today date
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_entry.user_id = p_user_id and p_entry.tracker_id = p_tracker.id
    and p_entry.deleted_at is null and p_entry.outcome = 'recorded'
    and p_entry.server_changed_at >= p_cutover
    and exists (
      select 1 from public.progression_award_state a
      where a.user_id = p_entry.user_id
        and a.award_key = md5(p_entry.user_id::text || ':' || p_entry.id::text || ':daily-check-in-v1')::uuid
        and a.updated_at > p_cutover
    )
    and p_entry.entry_date <= p_today
    and public.progression_tracker_date_in_period(p_tracker.definition, p_tracker.created_at, p_entry.entry_date, p_timezone)
$$;
revoke all on function public.progression_goal_milestone_entry_eligible(uuid, public.trackers, public.tracker_entries, timestamptz, text, date) from public, anon, authenticated, service_role;

create or replace function public.progression_entry_success_qualifies_on_date(
  p_definition jsonb, p_values jsonb, p_outcome text, p_date date
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.progression_entry_success_qualifies(
    public.progression_tracker_definition_for_date(p_definition, p_date), p_values, p_outcome
  )
$$;
revoke all on function public.progression_entry_success_qualifies_on_date(jsonb, jsonb, text, date) from public, anon, authenticated, service_role;

create or replace function public.progression_entry_streak_qualifies_on_date(
  p_definition jsonb, p_values jsonb, p_outcome text, p_date date
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.progression_entry_streak_qualifies(
    public.progression_tracker_definition_for_date(p_definition, p_date), p_values, p_outcome
  )
$$;
revoke all on function public.progression_entry_streak_qualifies_on_date(jsonb, jsonb, text, date) from public, anon, authenticated, service_role;

-- Validate the complete interval list at the same transaction boundary that
-- accepts a tracker sync operation. Keep the existing v9 trigger unchanged
-- except for its v10 milestone validation boundary above.
create or replace function public.validate_tracker_rule_versions_v10()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version jsonb;
  v_evaluation jsonb;
  v_current_evaluation jsonb;
  v_previous_date date;
  v_previous_revision integer := 0;
  v_revision integer;
  v_date date;
  v_id text;
  v_ids text[] := array[]::text[];
begin
  if new.schema_version <> 10 then return new; end if;
    if jsonb_typeof(new.definition->'ruleVersions') is distinct from 'array'
       or jsonb_array_length(new.definition->'ruleVersions') = 0 then
      raise exception 'schema v10 requires at least one tracker rule version' using errcode = '23514';
    end if;
    for v_version in
      select item from jsonb_array_elements(new.definition->'ruleVersions') as versions(item)
    loop
      v_id := nullif(v_version->>'id', '');
      if v_id is null or v_id = any(v_ids) then
        raise exception 'schema v10 rule version IDs must be present and unique' using errcode = '23514';
      end if;
      v_ids := array_append(v_ids, v_id);
      if coalesce(v_version->>'application', '') not in ('baseline', 'apply-from-today', 'recalculate-all-history') then
        raise exception 'schema v10 rule version has an unsupported application mode' using errcode = '23514';
      end if;
      if jsonb_typeof(v_version->'evaluation') is distinct from 'object'
         or jsonb_typeof(v_version->'evaluation'->'schedule') is distinct from 'object'
         or jsonb_typeof(v_version->'evaluation'->'metrics') is distinct from 'array' then
        raise exception 'schema v10 rule version requires evaluation settings, schedule, and measure definitions' using errcode = '23514';
      end if;
      if jsonb_typeof(v_version->'effectiveFrom') is distinct from 'string'
         or nullif(v_version->>'effectiveFrom', '') is null
         or jsonb_typeof(v_version->'revision') is distinct from 'number'
         or jsonb_typeof(v_version->'recordedAt') is distinct from 'string'
         or nullif(v_version->>'recordedAt', '') is null then
        raise exception 'schema v10 rule version requires an effective date, numeric revision, and recorded timestamp' using errcode = '23514';
      end if;
      begin
        v_date := (v_version->>'effectiveFrom')::date;
        v_revision := (v_version->>'revision')::integer;
        perform (v_version->>'recordedAt')::timestamptz;
      exception when others then
        raise exception 'schema v10 rule version has invalid date, revision, or recorded timestamp' using errcode = '23514';
      end;
      if (v_version->>'revision')::numeric <> v_revision
         or v_revision <= v_previous_revision
         or (v_previous_date is not null and v_date <= v_previous_date) then
        raise exception 'schema v10 rule versions must have increasing revisions and unique ordered effective dates' using errcode = '23514';
      end if;
      v_evaluation := v_version->'evaluation';
      if v_evaluation->>'streakRuleMode' is not null and v_evaluation->>'streakRuleMode' not in ('same-as-success', 'custom') then
        raise exception 'schema v10 rule version has an unsupported streak mode' using errcode = '23514';
      end if;
      if v_evaluation ? 'qualificationRule' and not public.tracker_rule_is_valid(v_evaluation, v_evaluation->'qualificationRule') then
        raise exception 'schema v10 rule version contains an invalid success rule' using errcode = '23514';
      end if;
      if v_evaluation->>'streakRuleMode' = 'custom'
         and (not (v_evaluation ? 'streakRule') or not public.tracker_rule_is_valid(v_evaluation, v_evaluation->'streakRule')) then
        raise exception 'schema v10 custom streak rule is invalid' using errcode = '23514';
      end if;
      if v_evaluation->>'streakRuleMode' = 'same-as-success'
         and v_evaluation ? 'streakRule'
         and jsonb_typeof(v_evaluation->'streakRule') is distinct from 'null' then
        raise exception 'schema v10 same-as-success versions cannot contain a separate streak rule' using errcode = '23514';
      end if;
      v_previous_date := v_date;
      v_previous_revision := v_revision;
    end loop;
    v_evaluation := new.definition->'ruleVersions'->-1->'evaluation';
    v_current_evaluation := jsonb_strip_nulls(jsonb_build_object(
      'schedule', new.definition->'schedule',
      'startDate', new.definition->'startDate',
      'deadline', new.definition->'deadline',
      'scheduling', new.definition->'scheduling',
      'metrics', new.definition->'metrics',
      'qualificationRule', new.definition->'qualificationRule',
      'streakRuleMode', new.definition->'streakRuleMode',
      'streakRule', new.definition->'streakRule',
      'strictMode', new.definition->'strictMode'
    ));
    if public.progression_tracker_evaluation_signature(v_evaluation)
       is distinct from public.progression_tracker_evaluation_signature(v_current_evaluation) then
      raise exception 'schema v10 latest rule version must match the tracker’s current evaluation settings' using errcode = '23514';
    end if;
  return new;
end;
$$;
revoke all on function public.validate_tracker_rule_versions_v10() from public, anon, authenticated, service_role;
drop trigger if exists tracker_rule_versions_v10_guard on public.trackers;
create trigger tracker_rule_versions_v10_guard
before insert or update of schema_version, definition on public.trackers
for each row execute function public.validate_tracker_rule_versions_v10();

-- Reconciliation walks must begin at the earliest saved evaluation start, and
-- raw-quantity milestone records must respect the effective period on their
-- own dates. These rewrites preserve the existing award and cutover routines.
do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_tracker_milestones(uuid,uuid)'::regprocedure);
  v_old := 'coalesce((v_tracker.definition->>''startDate'')::date, (v_tracker.created_at at time zone v_timezone)::date)';
  v_new := 'public.progression_tracker_history_start_date(v_tracker.definition, v_tracker.created_at, v_timezone)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected streak reconciliation start boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_typed_goal_milestone(uuid,public.trackers,jsonb,timestamptz,text,date,boolean)'::regprocedure);
  v_old := 'coalesce((p_tracker.definition->>''startDate'')::date, (p_tracker.created_at at time zone p_timezone)::date)';
  v_new := 'public.progression_tracker_history_start_date(p_tracker.definition, p_tracker.created_at, p_timezone)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected typed milestone start boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_goal_tracker(uuid,uuid)'::regprocedure);
  v_old := 'e.entry_date>=coalesce((v_tracker.definition->>''startDate'')::date,(v_tracker.created_at at time zone v_timezone)::date)';
  v_new := 'public.progression_tracker_date_in_period(v_tracker.definition, v_tracker.created_at, e.entry_date, v_timezone)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected goal milestone active-period boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_old := '(v_tracker.definition->>''deadline'' is null or e.entry_date<=(v_tracker.definition->>''deadline'')::date)';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected goal milestone deadline boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, 'true');
  execute v_definition;
end;
$$;

-- Every existing score/reward path already receives the date of its source.
-- Resolve JSON snapshots at those call sites so XP, milestones, perfect days,
-- and achievements all use the same effective-date semantics as the client.
do $$
declare
  v_proc record;
  v_definition text;
  v_updated text;
begin
  for v_proc in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.prosrc ~ 'progression_entry_(success_|streak_)?qualifies\('
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_proc.oid);
    v_updated := regexp_replace(v_definition,
      'public\.progression_entry_(success_|streak_)?qualifies\(([a-zA-Z_][a-zA-Z_0-9]*)\.definition,[[:space:]]*([a-zA-Z_][a-zA-Z_0-9]*)\.entry_values,[[:space:]]*([a-zA-Z_][a-zA-Z_0-9]*)\.outcome\)',
      'public.progression_entry_\1qualifies(public.progression_tracker_definition_for_date(\2.definition,\3.entry_date),\3.entry_values,\4.outcome)', 'g');
    if v_updated <> v_definition then execute v_updated; end if;
  end loop;

  v_definition := pg_catalog.pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure);
  v_updated := pg_catalog.replace(v_definition,
    'public.progression_entry_success_qualifies(v_tracker.definition, p_values, p_outcome)',
    'public.progression_entry_success_qualifies(public.progression_tracker_definition_for_date(v_tracker.definition, p_entry_date), p_values, p_outcome)');
  if v_updated = v_definition then
    raise exception 'Expected dated success qualification in progression entry award reconciliation was not found';
  end if;
  execute v_updated;
end;
$$;

-- Existing award reconciliation used tracker.updated_at as a conservative
-- boundary because older definitions had no history. V10 trackers carry
-- date-effective snapshots, so only legacy trackers may constrain that
-- boundary. Keep the account cutover checks in each routine unchanged.
do $$
declare
  v_proc record;
  v_definition text;
  v_updated text;
  v_rewritten integer := 0;
  v_required regprocedure[] := array[
    'public.progression_evaluate_perfect_day(uuid,date)'::regprocedure,
    'public.progression_evaluate_perfect_day_excluding(uuid,date,uuid)'::regprocedure,
    'public.progression_perfect_month_qualifies_legacy(uuid,date,uuid)'::regprocedure,
    'public.reconcile_progression_achievements_base(uuid)'::regprocedure,
    'public.reconcile_progression_extended_achievements(uuid)'::regprocedure,
    'public.reconcile_progression_new_badges_before_tracker_deletion()'::regprocedure,
    'public.reconcile_progression_tracker_trigger()'::regprocedure
  ];
  v_function regprocedure;
begin
  for v_proc in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and pg_catalog.strpos(p.prosrc, 't.updated_at') > 0
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_proc.oid);
    v_updated := pg_catalog.replace(v_definition,
      'max((t.updated_at at time zone v_timezone)::date)',
      'max((t.updated_at at time zone v_timezone)::date) filter (where t.schema_version < 10)');
    v_updated := pg_catalog.replace(v_updated,
      'max(t.updated_at at time zone v_timezone)::date',
      '(max(t.updated_at at time zone v_timezone) filter (where t.schema_version < 10))::date');
    v_updated := pg_catalog.replace(v_updated,
      'max((t.updated_at at time zone coalesce(s.timezone, ''UTC''))::date)',
      'max((t.updated_at at time zone coalesce(s.timezone, ''UTC''))::date) filter (where t.schema_version < 10)');
    v_updated := pg_catalog.replace(v_updated,
      'max(t.updated_at) at time zone v_timezone',
      '(max(t.updated_at) filter (where t.schema_version < 10)) at time zone v_timezone');
    if v_updated <> v_definition then
      execute v_updated;
      v_rewritten := v_rewritten + 1;
    end if;
  end loop;

  foreach v_function in array v_required loop
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    if pg_catalog.strpos(v_definition, 't.schema_version < 10') = 0 then
      raise exception 'The v10 history boundary rewrite did not reach %', v_function;
    end if;
  end loop;
  if v_rewritten < cardinality(v_required) then
    raise exception 'Expected at least % progression boundary functions to be rewritten; rewrote %', cardinality(v_required), v_rewritten;
  end if;
end;
$$;

-- An unsupported historical Perfect Day must remain untouched. It must not be
-- treated as a failed qualification and turned into an award reversal.
do $$
declare
  v_definition text;
  v_old text := '    v_state := public.progression_evaluate_perfect_day(p_user_id, p_date);';
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_perfect_day(uuid,date)'::regprocedure);
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected Perfect Day state evaluation was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_old,
    v_old || E'\n    if v_state = ''unsupported'' then return; end if;');
end;
$$;

comment on column public.trackers.definition is
  'Current tracker configuration and, for schema v10, ordered date-effective evaluation snapshots. Version history is nested in the owner-scoped tracker row and uses inclusive effectiveFrom dates.';
comment on column public.trackers.schema_version is
  'Tracker definition versions through v10; v10 stores validated date-effective evaluation snapshots and preserves v1-v9 compatibility.';
comment on function public.progression_tracker_definition_for_date(jsonb, date) is
  'Resolves the single tracker evaluation snapshot effective on a source activity date. Legacy definitions without snapshots retain their existing current-definition behavior.';
comment on function public.reconcile_progression_perfect_day(uuid, date) is
  'Reconciles supported date-effective tracker history; unsupported history is preserved rather than treated as ineligible.';

commit;
