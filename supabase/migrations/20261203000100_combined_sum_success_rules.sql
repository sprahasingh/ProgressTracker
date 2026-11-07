-- Combined Sum rules use active quantity/duration measures with the same
-- explicit unit. Missing individual values contribute zero; absent check-ins
-- continue to fail through the existing opportunity evaluator.
begin;

do $migration$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.tracker_rule_is_valid(jsonb,jsonb)'::regprocedure);
  v_marker text := '  if v_kind is null then return false; end if;';
  v_block text := $block$  if v_kind = 'combined-sum' then
    if jsonb_typeof(p_rule->'metricIds') is distinct from 'array' then return false; end if;
    if jsonb_array_length(p_rule->'metricIds') < 2 then return false; end if;
    if jsonb_typeof(p_rule->'target') is distinct from 'number' then return false; end if;
    if (p_rule->>'target')::numeric <= 0 then return false; end if;
    select count(*)::integer,
      coalesce(bool_and(metric.value is not null
        and metric.value->>'retiredAt' is null
        and metric.value->>'valueType' in ('quantity','duration')
        and nullif(btrim(metric.value->>'unit'),'') is not null), false),
      count(distinct lower(btrim(metric.value->>'unit')))::integer
      into v_count, v_valid, v_required
    from jsonb_array_elements_text(p_rule->'metricIds') as selected(id)
    left join lateral (
      select item.value
      from jsonb_array_elements(coalesce(p_definition->'metrics','[]'::jsonb)) item(value)
      where item.value->>'id' = selected.id
      limit 1
    ) metric on true;
    if v_count <> jsonb_array_length(p_rule->'metricIds')
      or (select count(distinct id) from jsonb_array_elements_text(p_rule->'metricIds') ids(id)) <> v_count
      or not v_valid or v_required <> 1 then return false; end if;
    return true;
  end if;
$block$;
begin
  if pg_catalog.strpos(v_definition, v_marker) = 0 then
    raise exception 'Expected tracker rule validation insertion point was not found';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_marker, v_marker || E'\n' || v_block);
  execute v_definition;
end;
$migration$;

do $migration$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.progression_rule_qualifies(jsonb,jsonb,jsonb)'::regprocedure);
  v_marker text := '    when ''threshold'' then';
  v_block text := $block$    when 'combined-sum' then
      if public.tracker_rule_is_valid(p_definition, p_rule) is not true then return false; end if;
      select count(*) filter (where saved.value is not null and saved.value <> 'null'::jsonb and jsonb_typeof(saved.value) <> 'number')::integer,
        coalesce(sum(case when jsonb_typeof(saved.value) = 'number' then (saved.value #>> '{}')::numeric else 0 end), 0)
        into v_count, v_progress
      from jsonb_array_elements_text(p_rule->'metricIds') selected(id)
      left join lateral (select p_values->selected.id as value) saved on true;
      return v_count = 0 and v_progress >= (p_rule->>'target')::numeric;
$block$;
begin
  if pg_catalog.strpos(v_definition, v_marker) = 0 then
    raise exception 'Expected progression rule insertion point was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_marker, v_block || v_marker);
end;
$migration$;

do $migration$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.progression_tracker_evaluation_signature(jsonb)'::regprocedure);
  v_marker text := '    select metric_id from fallback_metric';
  v_replacement text := $replacement$    select metric_id from fallback_metric
    union
    select jsonb_array_elements_text(node->'metricIds')
    from rule_nodes
    where node->>'kind' = 'combined-sum'
      and jsonb_typeof(node->'metricIds') = 'array'$replacement$;
begin
  if pg_catalog.strpos(v_definition, v_marker) = 0 then
    raise exception 'Expected evaluation signature insertion point was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_marker, v_replacement);
end;
$migration$;

create or replace function public.tracker_edit_rule_metric_ids(p_rule jsonb)
returns table(metric_id text)
language sql immutable set search_path = '' as $$
  with recursive nodes(value) as (
    select p_rule where jsonb_typeof(p_rule) = 'object'
    union all
    select operand.value
    from nodes parent
    cross join lateral jsonb_array_elements(
      case when parent.value->>'kind' in ('all','any','at-least') and jsonb_typeof(parent.value->'operands') = 'array'
        then parent.value->'operands' else '[]'::jsonb end
    ) operand(value)
  ), metric_refs(metric_id) as (
    select value->>'metricId' from nodes where value->>'kind' in ('threshold','comparison') and nullif(value->>'metricId','') is not null
    union all
    select jsonb_array_elements_text(value->'metricIds') from nodes where value->>'kind' = 'combined-sum' and jsonb_typeof(value->'metricIds') = 'array'
  ) select distinct metric_id from metric_refs
$$;
revoke all on function public.tracker_edit_rule_metric_ids(jsonb) from public, anon, authenticated, service_role;

-- This read-only capability probe is created atomically with the rule support.
-- It also checks the installed function definitions so a partial or later
-- removed implementation cannot advertise support.
create or replace function public.progress_tracker_capabilities()
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_combined_sum boolean;
begin
  select coalesce(pg_catalog.bool_and(
    installed.oid is not null
    and pg_catalog.strpos(pg_catalog.pg_get_functiondef(installed.oid), 'combined-sum') > 0
  ), false)
  into v_combined_sum
  from (values
    ('public.tracker_rule_is_valid(jsonb,jsonb)'),
    ('public.progression_rule_qualifies(jsonb,jsonb,jsonb)'),
    ('public.progression_tracker_evaluation_signature(jsonb)'),
    ('public.tracker_edit_rule_metric_ids(jsonb)')
  ) required(signature)
  left join lateral (select pg_catalog.to_regprocedure(required.signature) as oid) installed on true;

  return pg_catalog.jsonb_build_object(
    'version', 1,
    'capabilities', pg_catalog.jsonb_build_object('combinedSum', v_combined_sum)
  );
end;
$$;
revoke all on function public.progress_tracker_capabilities() from public, anon, service_role;
grant execute on function public.progress_tracker_capabilities() to authenticated;

commit;
