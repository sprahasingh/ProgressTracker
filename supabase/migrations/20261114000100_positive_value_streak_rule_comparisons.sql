-- Allow custom Streak Rules to qualify any numeric value greater than zero.
-- The serialized rule uses the shared comparison form with operator greater-than
-- and value zero, so no tracker schema version change is needed.

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
          when 'greater-than' then case when v_progress > (v_expected #>> '{}')::numeric then 1 else 0 end
          when 'at-least' then case when v_progress >= (v_expected #>> '{}')::numeric then 1 else 0 end
          when 'at-most' then case when v_progress <= (v_expected #>> '{}')::numeric then 1 else 0 end else 0 end;
        return v_progress = 1;
      end if;
      if jsonb_typeof(v_value) = 'number' and jsonb_typeof(v_expected) = 'number' then
        return case v_operator when 'equals' then (v_value #>> '{}')::numeric = (v_expected #>> '{}')::numeric
          when 'greater-than' then (v_value #>> '{}')::numeric > (v_expected #>> '{}')::numeric
          when 'at-least' then (v_value #>> '{}')::numeric >= (v_expected #>> '{}')::numeric
          when 'at-most' then (v_value #>> '{}')::numeric <= (v_expected #>> '{}')::numeric else false end;
      end if;
      return v_metric->>'valueType' = 'boolean' and v_operator = 'equals' and v_value = v_expected;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_rule_qualifies(jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
