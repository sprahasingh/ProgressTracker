-- Preserve the editor's dependency rule at the database write boundary.
begin;

create or replace function public.tracker_definition_references_measure(p_definition jsonb, p_measure_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive nodes(value) as (
    select coalesce(p_definition, '{}'::jsonb)
    union all
    select child.value
    from nodes parent
    cross join lateral (
      select item.value
      from jsonb_array_elements(case when jsonb_typeof(parent.value) = 'array' then parent.value else '[]'::jsonb end) as item(value)
      union all
      select property.value
      from jsonb_each(case when jsonb_typeof(parent.value) = 'object' then parent.value else '{}'::jsonb end) as property(key, value)
    ) as child
  )
  select exists (
    select 1 from nodes where value->>'metricId' = p_measure_id
  ) or exists (
    select 1
    from jsonb_each(case when jsonb_typeof(p_definition->'goalPlanning') = 'object' then p_definition->'goalPlanning' else '{}'::jsonb end) as section(key, value)
    cross join lateral jsonb_each(case when jsonb_typeof(section.value) = 'object' then section.value else '{}'::jsonb end) as metric(key, value)
    where metric.key = p_measure_id
  );
$$;
revoke all on function public.tracker_definition_references_measure(jsonb, text) from public, anon, authenticated, service_role;

create or replace function public.guard_tracker_measure_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_metric jsonb;
  v_new_metric jsonb;
  v_metric_id text;
begin
  for v_old_metric in
    select metric.value
    from jsonb_array_elements(coalesce(old.definition->'metrics', '[]'::jsonb)) as metric(value)
  loop
    v_metric_id := v_old_metric->>'id';
    if v_metric_id is null or coalesce(v_old_metric->>'retiredAt', '') <> '' then continue; end if;

    select metric.value into v_new_metric
    from jsonb_array_elements(coalesce(new.definition->'metrics', '[]'::jsonb)) as metric(value)
    where metric.value->>'id' = v_metric_id
    limit 1;

    if (v_new_metric is null or coalesce(v_new_metric->>'retiredAt', '') <> '')
       and public.tracker_definition_references_measure(new.definition, v_metric_id) then
      raise exception 'Measure % is used by a rule, goal plan, or milestone. Resolve those references before retiring or removing it.', v_metric_id
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.guard_tracker_measure_references() from public, anon, authenticated, service_role;

drop trigger if exists tracker_measure_reference_guard on public.trackers;
create trigger tracker_measure_reference_guard
  before update of definition on public.trackers
  for each row execute function public.guard_tracker_measure_references();

comment on function public.tracker_definition_references_measure(jsonb, text) is
  'Detects measure references in rule and milestone trees and measure-keyed goal planning maps.';
comment on function public.guard_tracker_measure_references() is
  'Prevents retiring or removing a measure while the saved tracker definition still depends on it.';

commit;
