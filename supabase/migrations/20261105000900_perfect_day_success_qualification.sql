-- Perfect Day is a daily success summary. Keep streak qualification unchanged,
-- but evaluate its entries using the same tracker success rule shown in Today.
begin;

create or replace function public.progression_entry_success_qualifies(
  p_definition jsonb, p_values jsonb, p_outcome text
)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_rule jsonb := p_definition->'qualificationRule';
  v_metric jsonb;
begin
  if p_outcome <> 'recorded' then return false; end if;
  if v_rule is not null and jsonb_typeof(v_rule) = 'object' then
    return public.progression_rule_qualifies(p_definition, p_values, v_rule);
  end if;
  select metric into v_metric
  from jsonb_array_elements(coalesce(p_definition->'metrics', '[]'::jsonb)) with ordinality as metrics(metric, position)
  where metric->>'retiredAt' is null
  order by position limit 1;
  if v_metric is null then return false; end if;
  -- progression_metric_level implements Today’s minimum/target/stretch
  -- classification and deliberately ignores streakQualification.
  return public.progression_metric_level(p_definition, p_values, v_metric->>'id') >= 1;
end;
$$;
revoke all on function public.progression_entry_success_qualifies(jsonb, jsonb, text) from public, anon, authenticated, service_role;

create or replace function public.progression_evaluate_perfect_day(p_user_id uuid, p_date date)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover date;
  v_definition_boundary date;
  v_required integer;
  v_qualified integer;
  v_failed integer;
  v_pending integer;
begin
  if p_user_id is null or p_date is null then return 'unsupported'; end if;
  select coalesce(s.timezone, 'UTC'),
      (clock_timestamp() at time zone coalesce(s.timezone, 'UTC'))::date,
      (a.initialized_at at time zone coalesce(s.timezone, 'UTC'))::date
    into v_timezone, v_today, v_cutover
  from public.progression_achievement_accounts a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return 'unsupported'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
    v_today := (clock_timestamp() at time zone 'UTC')::date;
    select (a.initialized_at at time zone 'UTC')::date into v_cutover
    from public.progression_achievement_accounts a where a.user_id = p_user_id;
  end if;
  if p_date > v_today then return 'future'; end if;

  select greatest(v_cutover, coalesce(max((t.updated_at at time zone v_timezone)::date), v_cutover))
    into v_definition_boundary
  from public.trackers t
  where t.user_id = p_user_id and t.status in ('active', 'archived') and t.deleted_at is null;
  if p_date < v_definition_boundary then return 'unsupported'; end if;

  select count(*)::integer,
      count(*) filter (where e.id is not null and e.deleted_at is null
        and e.outcome = 'recorded'
        and public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome))::integer,
      count(*) filter (where e.outcome = 'skipped' or (e.id is not null and e.deleted_at is null
        and not public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome) and p_date < v_today)
        or (e.id is null and p_date < v_today))::integer,
      count(*) filter (where p_date = v_today and (e.id is null or (e.outcome = 'recorded'
        and not public.progression_entry_success_qualifies(t.definition, e.entry_values, e.outcome))))::integer
    into v_required, v_qualified, v_failed, v_pending
  from public.trackers t
  left join public.tracker_entries e
    on e.user_id = t.user_id and e.tracker_id = t.id and e.entry_date = p_date and e.deleted_at is null
  where t.user_id = p_user_id
    and t.status in ('active', 'archived') and t.deleted_at is null
    and (t.status <> 'archived' or t.definition->>'archivedAt' is null
      or p_date <= pg_catalog.left(t.definition->>'archivedAt', 10)::date)
    and public.progression_date_is_eligible(p_user_id, t, p_date);

  if coalesce(v_required, 0) = 0 then return 'neutral'; end if;
  if coalesce(v_failed, 0) > 0 then return 'failed'; end if;
  if coalesce(v_pending, 0) > 0 then return 'pending'; end if;
  if v_qualified = v_required then return 'perfect'; end if;
  return 'failed';
end;
$$;
revoke all on function public.progression_evaluate_perfect_day(uuid, date) from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_perfect_day(p_user_id uuid, p_date date)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_cutover_at timestamptz;
  v_state text;
  v_key uuid;
begin
  if p_user_id is null or p_date is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':progression-perfect-day:' || p_date::text, 5)
  );
  select coalesce(s.timezone, 'UTC'), a.initialized_at
    into v_timezone, v_cutover_at
  from public.progression_account_state a
  left join public.app_settings s on s.user_id = a.user_id
  where a.user_id = p_user_id;
  if not found then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;
  if p_date > v_today or p_date < (v_cutover_at at time zone v_timezone)::date then return; end if;

  v_state := public.progression_evaluate_perfect_day(p_user_id, p_date);
  v_key := md5(p_user_id::text || ':perfect-day:' || p_date::text)::uuid;
  perform public.reconcile_progression_award(
    p_user_id, v_key, 'PERFECT_DAY_BONUS', p_date, 20, null, null, null,
    v_state = 'perfect', 'Every required tracker met its configured success rule on this date'
  );
end;
$$;
revoke all on function public.reconcile_progression_perfect_day(uuid, date) from public, anon, authenticated, service_role;

comment on function public.progression_entry_success_qualifies(jsonb, jsonb, text) is
  'Uses Today success qualification rules while intentionally ignoring the separate streakQualification threshold.';
comment on function public.progression_evaluate_perfect_day(uuid, date) is
  'Evaluates Perfect Day eligibility and configured tracker success rules; progression_evaluate_account_day remains streak-qualified for streak-based period achievements.';

commit;
