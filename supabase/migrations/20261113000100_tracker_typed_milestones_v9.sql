-- Typed milestones add explicit target semantics to tracker definitions. The
-- server keeps legacy checkpoints on their existing best-observation path.
begin;

alter table public.trackers drop constraint if exists trackers_schema_version_check;
alter table public.trackers add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5, 6, 7, 8, 9));

-- A v9 definition can carry typed milestones while retaining the implicit
-- streak behavior of a v1-v7 tracker. Explicit v8 rules remain validated.
alter table public.trackers drop constraint if exists trackers_streak_rule_v8_check;
alter table public.trackers add constraint trackers_streak_rule_v8_check check (
  case
    when schema_version < 8 then not (definition ? 'streakRuleMode') and not (definition ? 'streakRule')
    when schema_version = 8 then case definition->>'streakRuleMode'
      when 'same-as-success' then not (definition ? 'streakRule')
        and (not (definition ? 'qualificationRule') or public.tracker_rule_is_valid(definition, definition->'qualificationRule'))
      when 'custom' then definition ? 'streakRule'
        and public.tracker_rule_is_valid(definition, definition->'streakRule')
      else false
    end
    else case
      when not (definition ? 'streakRuleMode') then not (definition ? 'streakRule')
      when definition->>'streakRuleMode' = 'same-as-success' then not (definition ? 'streakRule')
        and (not (definition ? 'qualificationRule') or public.tracker_rule_is_valid(definition, definition->'qualificationRule'))
      when definition->>'streakRuleMode' = 'custom' then definition ? 'streakRule'
        and public.tracker_rule_is_valid(definition, definition->'streakRule')
      else false
    end
  end
);

create or replace function public.prevent_tracker_schema_downgrade()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_milestone jsonb;
  v_metric jsonb;
  v_type text;
  v_target numeric;
  v_measure_id text;
  v_mode text;
  v_total_days integer;
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
  if new.schema_version = 9 then
    for v_milestone in
      select item from jsonb_array_elements(coalesce(new.definition->'milestones', '[]'::jsonb)) as milestones(item)
    loop
      if not (v_milestone ? 'type') then continue; end if;
      v_type := v_milestone->>'type';
      if v_type is null or v_type not in ('cumulative-quantity', 'single-day-quantity', 'successful-days', 'streak-length', 'challenge-day', 'measure-completion-count') then
        raise exception 'schema v9 milestone has an unsupported type' using errcode = '23514';
      end if;
      if nullif(v_milestone->>'id', '') is null or jsonb_typeof(v_milestone->'targetValue') is distinct from 'number' then
        raise exception 'schema v9 milestones require an id and numeric target' using errcode = '23514';
      end if;
      v_target := (v_milestone->>'targetValue')::numeric;
      if v_target <= 0 or v_target > 9007199254740991 then raise exception 'schema v9 milestone targets must be positive and within the supported numeric range' using errcode = '23514'; end if;
      if v_type in ('successful-days', 'streak-length', 'challenge-day', 'measure-completion-count') and v_target <> trunc(v_target) then
        raise exception 'schema v9 day-count milestone targets must be whole numbers' using errcode = '23514';
      end if;
      v_measure_id := v_milestone->>'metricId';
      if v_type in ('cumulative-quantity', 'single-day-quantity', 'measure-completion-count') and nullif(v_measure_id, '') is null then
        raise exception 'schema v9 measure milestones require a measure id' using errcode = '23514';
      end if;
      if v_type in ('successful-days', 'streak-length', 'challenge-day') and v_measure_id is not null then
        raise exception 'schema v9 activity and challenge milestones cannot reference a measure' using errcode = '23514';
      end if;
      if v_type in ('cumulative-quantity', 'single-day-quantity', 'measure-completion-count') then
        select metric into v_metric from jsonb_array_elements(coalesce(new.definition->'metrics', '[]'::jsonb)) as metrics(metric)
          where metric->>'id' = v_measure_id limit 1;
        if v_metric is null then raise exception 'schema v9 milestone references an unavailable measure' using errcode = '23514'; end if;
      end if;
      if v_type in ('cumulative-quantity', 'single-day-quantity') then
        if (v_milestone->>'measureTypeSnapshot' is distinct from 'quantity'
            and v_milestone->>'measureTypeSnapshot' is distinct from 'duration')
           or jsonb_typeof(v_milestone->'unitSnapshot') is distinct from 'string' then
          raise exception 'schema v9 quantity milestones require a compatible numeric measure snapshot' using errcode = '23514';
        end if;
      end if;
      if v_type = 'measure-completion-count' then
        if v_milestone->>'measureTypeSnapshot' = 'boolean' and v_milestone->>'completionCondition' is distinct from 'true-day' then
          raise exception 'schema v9 Yes/No completion counts require the true-day condition' using errcode = '23514';
        end if;
        if v_milestone->>'measureTypeSnapshot' = 'checklist'
           and v_milestone->>'completionCondition' is distinct from 'checklist-item-day'
           and v_milestone->>'completionCondition' is distinct from 'checklist-complete-day' then
          raise exception 'schema v9 checklist counts require an item or full-checklist condition' using errcode = '23514';
        end if;
        if v_milestone->>'measureTypeSnapshot' = 'checklist' and v_milestone->>'completionCondition' = 'checklist-item-day'
           and nullif(v_milestone->>'checklistItemId', '') is null then
          raise exception 'schema v9 checklist item milestones require a checklist item id' using errcode = '23514';
        end if;
        if v_milestone->>'measureTypeSnapshot' = 'checklist' and v_milestone->>'completionCondition' = 'checklist-complete-day'
           and (jsonb_typeof(v_milestone->'checklistItemsSnapshot') is distinct from 'array'
             or jsonb_array_length(coalesce(v_milestone->'checklistItemsSnapshot', '[]'::jsonb)) = 0) then
          raise exception 'schema v9 full checklist milestones require a checklist snapshot' using errcode = '23514';
        end if;
        if v_milestone->>'measureTypeSnapshot' is distinct from 'boolean'
           and v_milestone->>'measureTypeSnapshot' is distinct from 'checklist' then
          raise exception 'schema v9 completion counts support Yes/No or checklist measures' using errcode = '23514';
        end if;
      end if;
      if v_type = 'challenge-day' then
        if new.kind <> 'challenge' then raise exception 'challenge-day milestones require a challenge tracker' using errcode = '23514'; end if;
        v_mode := new.definition->'scheduling'->>'mode';
        if v_mode is distinct from 'calendar' and v_mode is distinct from 'effective' then raise exception 'challenge-day milestones require a fixed duration' using errcode = '23514'; end if;
        if v_mode = 'effective' then
          v_total_days := (new.definition->'scheduling'->>'effectiveDays')::integer;
        else
          v_total_days := (new.definition->>'deadline')::date - coalesce((new.definition->>'startDate')::date, (new.created_at at time zone 'UTC')::date) + 1;
        end if;
        if v_total_days is null or v_target > v_total_days then raise exception 'challenge-day target exceeds the configured duration' using errcode = '23514'; end if;
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_tracker_schema_downgrade() from public, anon, authenticated;

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
    and p_entry.entry_date >= coalesce((p_tracker.definition->>'startDate')::date, (p_tracker.created_at at time zone p_timezone)::date)
    and (p_tracker.definition->>'deadline' is null or p_entry.entry_date <= (p_tracker.definition->>'deadline')::date)
$$;
revoke all on function public.progression_goal_milestone_entry_eligible(uuid, public.trackers, public.tracker_entries, timestamptz, text, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_typed_goal_milestone(
  p_user_id uuid,
  p_tracker public.trackers,
  p_milestone jsonb,
  p_cutover timestamptz,
  p_timezone text,
  p_today date,
  p_completed boolean
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_type text := p_milestone->>'type';
  v_metric_id text := p_milestone->>'metricId';
  v_target numeric;
  v_metric jsonb;
  v_current numeric := 0;
  v_crossed_date date;
  v_satisfied boolean := false;
  v_start date;
  v_award_key uuid;
begin
  if nullif(p_milestone->>'id', '') is null or jsonb_typeof(p_milestone->'targetValue') is distinct from 'number' then return; end if;
  v_target := (p_milestone->>'targetValue')::numeric;
  v_award_key := md5(p_user_id::text || ':goal-tracker-milestone:' || p_tracker.id::text || ':' || (p_milestone->>'id'))::uuid;

  if v_type in ('cumulative-quantity', 'single-day-quantity', 'measure-completion-count') then
    select metric into v_metric from jsonb_array_elements(coalesce(p_tracker.definition->'metrics', '[]'::jsonb)) as metrics(metric)
      where metric->>'id' = v_metric_id limit 1;
  end if;

  -- Saved snapshots define the interpretation. A changed type or unit stops
  -- the old checkpoint from silently measuring a different thing.
  if v_type in ('cumulative-quantity', 'single-day-quantity') and (
       v_metric->>'valueType' is distinct from p_milestone->>'measureTypeSnapshot'
       or coalesce(v_metric->>'unit', '') is distinct from coalesce(p_milestone->>'unitSnapshot', '')) then
    v_metric := null;
  elsif v_type = 'measure-completion-count'
    and v_metric->>'valueType' is distinct from p_milestone->>'measureTypeSnapshot' then
    v_metric := null;
  end if;

  if v_type = 'cumulative-quantity' and v_metric->>'valueType' in ('quantity', 'duration') then
    with observations as (
      select e.entry_date, (e.entry_values->>v_metric_id)::numeric as metric_value
      from public.tracker_entries e
      where public.progression_goal_milestone_entry_eligible(p_user_id, p_tracker, e, p_cutover, p_timezone, p_today)
        and jsonb_typeof(e.entry_values->v_metric_id) = 'number'
        and (e.entry_values->>v_metric_id)::numeric >= 0
    ), totals as (
      select entry_date, sum(metric_value) over(order by entry_date rows between unbounded preceding and current row) as running_total
      from observations
    )
    select coalesce(max(running_total), 0), min(entry_date) filter(where running_total >= v_target)
      into v_current, v_crossed_date from totals;
  elsif v_type = 'single-day-quantity' and v_metric->>'valueType' in ('quantity', 'duration') then
    with observations as (
      select e.entry_date, (e.entry_values->>v_metric_id)::numeric as metric_value
      from public.tracker_entries e
      where public.progression_goal_milestone_entry_eligible(p_user_id, p_tracker, e, p_cutover, p_timezone, p_today)
        and jsonb_typeof(e.entry_values->v_metric_id) = 'number'
        and (e.entry_values->>v_metric_id)::numeric >= 0
    )
    select case when v_metric->'thresholds'->>'direction' = 'decrease' then min(metric_value) else coalesce(max(metric_value), 0) end,
      min(entry_date) filter(where case when v_metric->'thresholds'->>'direction' = 'decrease' then metric_value <= v_target else metric_value >= v_target end)
      into v_current, v_crossed_date from observations;
  elsif v_type = 'successful-days' then
    with qualifying_dates as (
      select e.entry_date
      from public.tracker_entries e
      where public.progression_goal_milestone_entry_eligible(p_user_id, p_tracker, e, p_cutover, p_timezone, p_today)
        and public.progression_date_is_eligible(p_user_id, p_tracker, e.entry_date)
        and public.progression_entry_success_qualifies(p_tracker.definition, e.entry_values, e.outcome)
    ), numbered as (
      select entry_date, row_number() over(order by entry_date) as day_number from qualifying_dates
    )
    select count(*)::numeric, min(entry_date) filter(where day_number = v_target)
      into v_current, v_crossed_date from numbered;
  elsif v_type = 'streak-length' then
    v_start := greatest(
      coalesce((p_tracker.definition->>'startDate')::date, (p_tracker.created_at at time zone p_timezone)::date),
      (p_cutover at time zone p_timezone)::date
    );
    if v_start <= p_today then
      with opportunities as (
        select days.activity_at::date as activity_date,
          entry.id is not null
            and public.progression_goal_milestone_entry_eligible(p_user_id, p_tracker, entry, p_cutover, p_timezone, p_today)
            and public.progression_entry_streak_qualifies(p_tracker.definition, entry.entry_values, entry.outcome) as qualifies
        from lateral generate_series(v_start::timestamp, p_today::timestamp, interval '1 day') as days(activity_at)
        left join public.tracker_entries entry on entry.user_id = p_user_id and entry.tracker_id = p_tracker.id
          and entry.entry_date = days.activity_at::date and entry.deleted_at is null
        where public.progression_date_is_eligible(p_user_id, p_tracker, days.activity_at::date)
      ), groups as (
        select activity_date, qualifies,
          sum(case when qualifies then 0 else 1 end) over(order by activity_date) as run_group
        from opportunities
      ), runs as (
        select min(activity_date) as run_start, count(*)::numeric as run_length
        from groups where qualifies group by run_group
      )
      select coalesce(max(run_length), 0), min(run_start + (v_target::integer - 1)) filter(where run_length >= v_target)
        into v_current, v_crossed_date from runs;
    end if;
  elsif v_type = 'measure-completion-count' and v_metric->>'valueType' in ('boolean', 'checklist') then
    with qualifying_dates as (
      select e.entry_date
      from public.tracker_entries e
      where public.progression_goal_milestone_entry_eligible(p_user_id, p_tracker, e, p_cutover, p_timezone, p_today)
        and (
          (p_milestone->>'completionCondition' = 'true-day' and v_metric->>'valueType' = 'boolean' and e.entry_values->v_metric_id = 'true'::jsonb)
          or (p_milestone->>'completionCondition' = 'checklist-item-day' and v_metric->>'valueType' = 'checklist'
            and (e.entry_values->v_metric_id)->(p_milestone->>'checklistItemId') = 'true'::jsonb)
          or (p_milestone->>'completionCondition' = 'checklist-complete-day' and v_metric->>'valueType' = 'checklist'
            and jsonb_typeof(p_milestone->'checklistItemsSnapshot') = 'array'
            and jsonb_array_length(p_milestone->'checklistItemsSnapshot') > 0
            and not exists(select 1 from jsonb_array_elements_text(p_milestone->'checklistItemsSnapshot') as item(item_id)
              where (e.entry_values->v_metric_id)->item.item_id is distinct from 'true'::jsonb))
        )
    ), numbered as (
      select entry_date, row_number() over(order by entry_date) as day_number from qualifying_dates
    )
    select count(*)::numeric, min(entry_date) filter(where day_number = v_target)
      into v_current, v_crossed_date from numbered;
  end if;

  if v_type = 'single-day-quantity' and v_metric->'thresholds'->>'direction' = 'decrease' then
    v_satisfied := coalesce(v_current <= v_target, false) and v_crossed_date is not null and v_target > 0;
  else
    v_satisfied := coalesce(v_current >= v_target, false) and v_target > 0;
  end if;
  perform public.reconcile_progression_award(p_user_id, v_award_key, 'GOAL_MILESTONE', coalesce(v_crossed_date, p_today), 25,
    p_tracker.id, null, null, v_satisfied and not p_completed, 'A configured goal milestone was reached');
end;
$$;
revoke all on function public.reconcile_progression_typed_goal_milestone(uuid, public.trackers, jsonb, timestamptz, text, date, boolean) from public, anon, authenticated, service_role;

do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_goal_tracker(uuid,uuid)'::regprocedure);
  v_old := $old$  for v_milestone in select milestone from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) as milestones(milestone) loop
    if jsonb_typeof(v_milestone->'targetValue') is distinct from 'number'$old$;
  v_new := $new$  for v_milestone in select milestone from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) as milestones(milestone) loop
    if v_milestone ? 'type' then
      perform public.reconcile_progression_typed_goal_milestone(p_user_id, v_tracker, v_milestone, v_cutover, v_timezone, v_today, v_completed);
      continue;
    end if;
    if jsonb_typeof(v_milestone->'targetValue') is distinct from 'number'$new$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected goal milestone loop was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

comment on column public.trackers.schema_version is
  'Tracker definition versions through v9; v9 stores explicit milestone target semantics and preserves definitions v1-v8.';
comment on function public.reconcile_progression_typed_goal_milestone(uuid, public.trackers, jsonb, timestamptz, text, date, boolean) is
  'Reconciles the existing 25 XP goal milestone award only when an explicitly typed goal milestone meets its own calculation.';

commit;
