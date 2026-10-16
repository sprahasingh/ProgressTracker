-- Reject malformed comparison leaves with a missing rule kind or operator.
-- SQL's NULL NOT IN (...) evaluates to unknown, so the required fields need
-- explicit checks before the type/operator allowlists.

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
  if v_kind is null then return false; end if;
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
  if v_operator is null then return false; end if;
  if v_metric->>'valueType' = 'boolean' then
    return v_operator = 'equals' and jsonb_typeof(v_value) = 'boolean';
  end if;
  if v_metric->>'valueType' not in ('quantity', 'duration', 'checklist')
    or jsonb_typeof(v_value) <> 'number'
    or v_operator not in ('equals', 'greater-than', 'at-least', 'at-most') then return false; end if;
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
