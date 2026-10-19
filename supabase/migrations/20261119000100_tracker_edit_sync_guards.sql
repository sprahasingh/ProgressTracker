-- Add authoritative, recoverable checks to the existing serialized sync path.
-- The original writer remains the single persistence implementation; this
-- wrapper validates the check-in boundary while holding its tracker lock.
begin;

-- Recursively expose every measure referenced by nested success/streak rules.
create function public.tracker_edit_rule_metric_ids(p_rule jsonb)
returns table(metric_id text)
language sql
immutable
set search_path = ''
as $$
  with recursive nodes(value) as (
    select p_rule
    where jsonb_typeof(p_rule) = 'object'
    union all
    select operand.value
    from nodes parent
    cross join lateral jsonb_array_elements(
      case when parent.value->>'kind' in ('all','any','at-least')
        and jsonb_typeof(parent.value->'operands') = 'array'
        then parent.value->'operands' else '[]'::jsonb end
    ) operand(value)
  )
  select distinct value->>'metricId' from nodes
  where value->>'kind' in ('threshold','comparison') and nullif(value->>'metricId','') is not null
$$;
revoke all on function public.tracker_edit_rule_metric_ids(jsonb) from public, anon, authenticated, service_role;

-- A distinct, authenticated probe lets clients fail closed when the feature
-- flag is set but this contract migration is absent on the connected server.
create function public.tracker_edit_sync_guards_contract()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else 'tracker-edit-sync-guards:v1' end
$$;
revoke all on function public.tracker_edit_sync_guards_contract() from public, anon;
grant execute on function public.tracker_edit_sync_guards_contract() to authenticated;

alter function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb)
  rename to apply_tracker_sync_operation_unchecked;

create function public.apply_tracker_sync_operation(
  p_expected_user_id uuid, p_operation_id uuid, p_entity text,
  p_expected_revision bigint, p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_tracker_id uuid;
  v_tracker public.trackers%rowtype;
  v_existing_entry public.tracker_entries%rowtype;
  v_receipt public.sync_operation_receipts%rowtype;
  v_entry_date date;
  v_latest_date date;
  v_effective_date date;
  v_definition jsonb;
  v_entry_values jsonb;
  v_metric jsonb;
  v_value jsonb;
  v_metric_id text;
  v_field_id text;
  v_field jsonb;
  v_field_value jsonb;
  v_existing_field_value jsonb;
  v_current_custom_fields jsonb;
  v_proposed_custom_fields jsonb;
  v_custom_fields_changed boolean;
  v_has_existing_entry boolean;
  v_existing_field boolean;
  v_field_unchanged boolean;
  v_field_valid boolean;
  v_metric_valid boolean;
  v_metric_unchanged boolean;
  v_increment numeric;
  v_checklist_item_id text;
  v_policy text;
  v_workspace_today date;
  v_workspace_timezone text;
  v_old_version jsonb;
  v_permanently_deleted_at timestamptz;
  v_dependency_id text;
  v_historical_metric jsonb;
  v_proposed_metric jsonb;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match sync workspace' using errcode = '42501';
  end if;
  if p_operation_id is null or p_entity not in ('tracker', 'tracker_entry') or p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'invalid sync operation' using errcode = '22023';
  end if;
  v_tracker_id := case when p_entity = 'tracker' then (p_record->>'id')::uuid else (p_record->>'tracker_id')::uuid end;
  if v_tracker_id is null then raise exception 'tracker id is required' using errcode = '22023'; end if;

  -- Match the established tracker/entry serialization lock.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_tracker_id::text, 0));
  select permanently_deleted_at into v_permanently_deleted_at from public.tracker_deletion_ledger
    where user_id = v_user_id and tracker_id = v_tracker_id;
  if found then
    return jsonb_build_object('status', 'permanently_deleted', 'tracker_id', v_tracker_id,
      'permanently_deleted_at', v_permanently_deleted_at);
  end if;
  if p_entity = 'tracker_entry' and exists (
    select 1 from public.trackers where user_id = v_user_id and id = v_tracker_id and deleted_at is not null
  ) then
    return jsonb_build_object('status', 'parent_in_bin', 'tracker_id', v_tracker_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id::text, 1));
  select * into v_receipt from public.sync_operation_receipts
    where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.entity is distinct from p_entity
       or v_receipt.expected_revision is distinct from p_expected_revision
       or v_receipt.record_payload is distinct from p_record then
      raise exception 'operation id was reused with a different payload' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;
  select * into v_tracker from public.trackers
    where user_id = v_user_id and id = v_tracker_id for update;

  -- Custom-field availability is not date-versioned in any tracker schema.
  -- Keep its definition stable for existing trackers and apply the same
  -- conservative entry checks to legacy queued writes. v10-only rule and
  -- measure checks remain below, using their date-effective snapshots.
  if p_entity = 'tracker' and found then
    select max(entry_date) into v_latest_date from public.tracker_entries
      where user_id = v_user_id and tracker_id = v_tracker_id and deleted_at is null;

    if v_tracker.schema_version < 10
       and p_record->'definition'->>'schemaVersion' = '10'
       and p_record->'definition'->'ruleVersions'->-1->>'historyPolicy' = 'recalculate-all-history' then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

    -- v10 snapshots do not contain custom-field definitions. Preserve only
    -- presentation ordering changes until field availability can be versioned.
    select coalesce(jsonb_agg(field.value - 'position' order by field.value->>'id'), '[]'::jsonb)
      into v_current_custom_fields
      from jsonb_array_elements(coalesce(v_tracker.definition->'customFields', '[]'::jsonb)) as field(value);
    select coalesce(jsonb_agg(field.value - 'position' order by field.value->>'id'), '[]'::jsonb)
      into v_proposed_custom_fields
      from jsonb_array_elements(coalesce(p_record->'definition'->'customFields', '[]'::jsonb)) as field(value);
    v_custom_fields_changed := v_current_custom_fields is distinct from v_proposed_custom_fields;
    if v_custom_fields_changed then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

    if v_tracker.schema_version = 10 then

    if coalesce(p_record->'definition'->'metrics', '[]'::jsonb)
       is distinct from coalesce(v_tracker.definition->'metrics', '[]'::jsonb)
       and (
         p_record->'definition'->'ruleVersions'->-1->>'id'
           is not distinct from v_tracker.definition->'ruleVersions'->-1->>'id'
         or p_record->'definition'->'ruleVersions'->-1->>'historyPolicy' is null
         or p_record->'definition'->'ruleVersions'->-1->>'historyPolicy' = 'recalculate-all-history'
       ) then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

    if coalesce(p_record->'definition'->'milestones', '[]'::jsonb)
       is distinct from coalesce(v_tracker.definition->'milestones', '[]'::jsonb) then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

    if (coalesce(p_record->'definition'->'metrics', '[]'::jsonb)
        is distinct from coalesce(v_tracker.definition->'metrics', '[]'::jsonb)
        or v_custom_fields_changed)
       and p_record->'definition'->'ruleVersions'->-1->>'historyPolicy' = 'recalculate-all-history' then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;
    if v_tracker.schema_version = 10 and v_tracker.kind = 'goal' and coalesce(p_record->'definition'->'goalPlanning', 'null'::jsonb)
       is distinct from coalesce(v_tracker.definition->'goalPlanning', 'null'::jsonb) then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

    -- Any changed measure structure needs a prospective boundary strictly
    -- after the latest server check-in. This catches another-device writes.
    if (coalesce(p_record->'definition'->'metrics', '[]'::jsonb)
       is distinct from coalesce(v_tracker.definition->'metrics', '[]'::jsonb)
       or v_custom_fields_changed)
       and v_latest_date is not null then
      begin
        v_effective_date := (p_record->'definition'->'ruleVersions'->-1->>'effectiveFrom')::date;
      exception when others then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end;
      if v_effective_date is null or v_effective_date <= v_latest_date then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end if;
    end if;

    if p_record->'definition'->'ruleVersions'->-1->>'id'
       is distinct from v_tracker.definition->'ruleVersions'->-1->>'id' then
      v_policy := p_record->'definition'->'ruleVersions'->-1->>'historyPolicy';
      if v_policy is null or v_policy not in ('apply-from-today', 'after-last-check-in', 'recalculate-all-history') then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end if;
      -- Every newly effective success/streak rule must reference a measure
      -- active in that same snapshot, including stale or offline tracker writes.
      if exists (
        select 1
        from (
          select metric_id from public.tracker_edit_rule_metric_ids(p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule')
          union
          select metric_id from public.tracker_edit_rule_metric_ids(
            case when p_record->'definition'->'ruleVersions'->-1->'evaluation'->>'streakRuleMode' = 'custom'
              then p_record->'definition'->'ruleVersions'->-1->'evaluation'->'streakRule'
              else p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule' end)
          union
          select implicit.metric_id from (
            select metric.value->>'id' as metric_id
            from jsonb_array_elements(coalesce(p_record->'definition'->'ruleVersions'->-1->'evaluation'->'metrics','[]'::jsonb)) with ordinality metric(value, position)
            where p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule' is null
              and metric.value->'retiredAt' is null
            order by metric.position limit 1
          ) implicit
        ) dependency
        where not exists (
          select 1 from jsonb_array_elements(coalesce(p_record->'definition'->'ruleVersions'->-1->'evaluation'->'metrics','[]'::jsonb)) metric(value)
          where metric.value->>'id' = dependency.metric_id and metric.value->'retiredAt' is null
        )
      ) then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end if;
      select (clock_timestamp() at time zone coalesce(settings.timezone, 'UTC'))::date
        into v_workspace_today from public.app_settings settings where settings.user_id = v_user_id;
      v_workspace_today := coalesce(v_workspace_today, (clock_timestamp() at time zone 'UTC')::date);
      v_effective_date := (p_record->'definition'->'ruleVersions'->-1->>'effectiveFrom')::date;
      if v_tracker.schema_version = 10 and v_policy <> 'recalculate-all-history' then
        for v_old_version in
          select version.value from jsonb_array_elements(coalesce(v_tracker.definition->'ruleVersions', '[]'::jsonb)) version(value)
        loop
          if (v_old_version->>'effectiveFrom')::date < v_effective_date
             and not exists (
               select 1 from jsonb_array_elements(coalesce(p_record->'definition'->'ruleVersions', '[]'::jsonb)) proposed(value)
               where proposed.value = v_old_version
             ) then
            return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
          end if;
        end loop;
      end if;
      if v_policy = 'recalculate-all-history' and v_tracker.schema_version = 10 and (
        coalesce(p_record->'definition'->'schedule', 'null'::jsonb) is distinct from coalesce(v_tracker.definition->'schedule', 'null'::jsonb)
        or coalesce(p_record->'definition'->'startDate', 'null'::jsonb) is distinct from coalesce(v_tracker.definition->'startDate', 'null'::jsonb)
        or coalesce(p_record->'definition'->'deadline', 'null'::jsonb) is distinct from coalesce(v_tracker.definition->'deadline', 'null'::jsonb)
        or coalesce(p_record->'definition'->'scheduling', 'null'::jsonb) is distinct from coalesce(v_tracker.definition->'scheduling', 'null'::jsonb)
        or coalesce(p_record->'definition'->'metrics', '[]'::jsonb) is distinct from coalesce(v_tracker.definition->'metrics', '[]'::jsonb)
        or v_custom_fields_changed
        or coalesce(p_record->'definition'->'goalPlanning', 'null'::jsonb) is distinct from coalesce(v_tracker.definition->'goalPlanning', 'null'::jsonb)
      ) then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end if;
      if v_policy = 'recalculate-all-history' and v_tracker.schema_version = 10 then
        select coalesce(settings.timezone, 'UTC') into v_workspace_timezone
        from public.app_settings settings where settings.user_id = v_user_id;
        v_workspace_timezone := coalesce(v_workspace_timezone, 'UTC');
        if (v_tracker.definition->'ruleVersions'->0->>'effectiveFrom')::date
           > public.progression_tracker_history_start_date(v_tracker.definition, v_tracker.created_at, v_workspace_timezone) then
          return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
        end if;
        -- Successful-day and streak milestones directly depend on historical
        -- rules; their definitions are not date-versioned, so preserve them.
        if exists (
          select 1 from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) milestone(value)
          where milestone.value->>'type' in ('successful-days','streak-length')
        ) then
          return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
        end if;

        -- Include direct rule refs and indirect goal/milestone metric refs.
        for v_dependency_id in
          select metric_id from public.tracker_edit_rule_metric_ids(p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule')
          union
          select metric_id from public.tracker_edit_rule_metric_ids(
            case when p_record->'definition'->'ruleVersions'->-1->'evaluation'->>'streakRuleMode' = 'custom'
              then p_record->'definition'->'ruleVersions'->-1->'evaluation'->'streakRule'
              else p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule' end)
          union
          select implicit.metric_id from (
            select metric.value->>'id' as metric_id
            from jsonb_array_elements(coalesce(p_record->'definition'->'ruleVersions'->-1->'evaluation'->'metrics','[]'::jsonb)) with ordinality metric(value, position)
            where p_record->'definition'->'ruleVersions'->-1->'evaluation'->'qualificationRule' is null
              and metric.value->'retiredAt' is null
            order by metric.position limit 1
          ) implicit
          union
          select milestone.value->>'metricId'
          from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) milestone(value)
          where nullif(milestone.value->>'metricId','') is not null
          union
          select target.key
          from jsonb_each(coalesce(v_tracker.definition->'goalPlanning','{}'::jsonb)) section(key,value)
          cross join lateral jsonb_object_keys(case when jsonb_typeof(section.value) = 'object' then section.value else '{}'::jsonb end) target(key)
          where section.key in ('progressSemantics','dailyTargets','cumulativeTargets','allocations','manualAllocations')
        loop
          select metric.value into v_proposed_metric
          from jsonb_array_elements(coalesce(p_record->'definition'->'metrics','[]'::jsonb)) metric(value)
          where metric.value->>'id' = v_dependency_id limit 1;
          if not found or v_proposed_metric->>'retiredAt' is not null then
            return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
          end if;
          for v_old_version in
            select version.value from jsonb_array_elements(coalesce(v_tracker.definition->'ruleVersions','[]'::jsonb)) version(value)
          loop
            select metric.value into v_historical_metric
            from jsonb_array_elements(coalesce(v_old_version->'evaluation'->'metrics','[]'::jsonb)) metric(value)
            where metric.value->>'id' = v_dependency_id limit 1;
            if not found or v_historical_metric->>'retiredAt' is not null
               or jsonb_build_array(v_historical_metric->>'id',v_historical_metric->>'name',v_historical_metric->>'valueType',
                    v_historical_metric->'unit',v_historical_metric->'thresholds',v_historical_metric->'checklistItems')
                  is distinct from
                  jsonb_build_array(v_proposed_metric->>'id',v_proposed_metric->>'name',v_proposed_metric->>'valueType',
                    v_proposed_metric->'unit',v_proposed_metric->'thresholds',v_proposed_metric->'checklistItems') then
              return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
            end if;
          end loop;
        end loop;
      end if;
      if v_policy = 'after-last-check-in'
         and v_effective_date is distinct from coalesce(v_latest_date + 1, v_workspace_today) then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      elsif v_policy = 'apply-from-today'
         and (v_effective_date is distinct from v_workspace_today or v_latest_date > v_workspace_today) then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      elsif v_policy = 'recalculate-all-history' and (
        exists (select 1 from public.tracker_entries entry where entry.user_id = v_user_id
          and entry.tracker_id = v_tracker_id and entry.deleted_at is null and entry.entry_date > v_workspace_today)
        or exists (
          select 1
          from public.tracker_entries entry
          cross join lateral jsonb_array_elements(coalesce(
            public.progression_tracker_definition_for_date(p_record->'definition', entry.entry_date)->'metrics', '[]'::jsonb
          )) metric(value)
          where entry.user_id = v_user_id and entry.tracker_id = v_tracker_id
            and entry.deleted_at is null and entry.outcome = 'recorded'
            and metric.value->>'retiredAt' is null
            and not (coalesce(entry.entry_values, '{}'::jsonb) ? (metric.value->>'id'))
        )
      ) then
        return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
      end if;
    end if;
    end if;
  elsif p_entity = 'tracker_entry' and found then
    v_entry_date := (p_record->>'entry_date')::date;
    select * into v_existing_entry from public.tracker_entries
      where user_id = v_user_id and id = (p_record->>'id')::uuid and tracker_id = v_tracker_id
      for update;
    v_has_existing_entry := found;
    if p_record ? 'entry_values' and jsonb_typeof(p_record->'entry_values') is distinct from 'object' then
      return jsonb_build_object('status', 'conflict', 'record', null);
    end if;
    v_entry_values := case
      when p_record ? 'entry_values' then p_record->'entry_values'
      when v_has_existing_entry then coalesce(v_existing_entry.entry_values, '{}'::jsonb)
      else '{}'::jsonb
    end;
    v_definition := public.progression_tracker_definition_for_date(v_tracker.definition, v_entry_date);
    select (clock_timestamp() at time zone coalesce(settings.timezone, 'UTC'))::date
      into v_workspace_today from public.app_settings settings where settings.user_id = v_user_id;
    v_workspace_today := coalesce(v_workspace_today, (clock_timestamp() at time zone 'UTC')::date);
    for v_metric_id, v_value in select key, value from jsonb_each(coalesce(v_entry_values, '{}'::jsonb))
    loop
      if v_metric_id like 'field:%' then
        v_field_id := substr(v_metric_id, 7);
        if v_field_id = '' then return jsonb_build_object('status', 'conflict', 'record', null); end if;

        v_existing_field := v_has_existing_entry
          and coalesce(v_existing_entry.entry_values, '{}'::jsonb) ? v_metric_id;
        v_existing_field_value := case when v_existing_field
          then v_existing_entry.entry_values->v_metric_id else null end;
        v_field_unchanged := v_existing_field and v_existing_field_value is not distinct from v_value;
        if v_field_unchanged then continue; end if;

        select field.value into v_field
          from jsonb_array_elements(coalesce(v_tracker.definition->'customFields', '[]'::jsonb)) as field(value)
          where field.value->>'id' = v_field_id
          limit 1;
        if not found then return jsonb_build_object('status', 'conflict', 'record', null); end if;

        -- A saved value on this exact server entry proves that the field was
        -- available for that historical record. For a new value, no field
        -- creation date exists, so only today's active definition is provable.
        if v_field ? 'retiredAt'
           or (not v_existing_field and v_entry_date <> v_workspace_today) then
          return jsonb_build_object('status', 'conflict', 'record', null);
        end if;

        v_field_valid := case v_field->>'type'
          when 'boolean' then jsonb_typeof(v_value) = 'boolean'
          when 'integer' then jsonb_typeof(v_value) = 'number' and (v_value::text)::numeric = trunc((v_value::text)::numeric)
          when 'decimal' then jsonb_typeof(v_value) = 'number'
          when 'duration' then jsonb_typeof(v_value) = 'number'
          when 'rating' then jsonb_typeof(v_value) = 'number'
          when 'quantity' then jsonb_typeof(v_value) = 'number'
          when 'multi-select' then jsonb_typeof(v_value) = 'array'
            and not exists (select 1 from jsonb_array_elements(
              case when jsonb_typeof(v_value) = 'array' then v_value else '[]'::jsonb end
            ) as option(value) where jsonb_typeof(option.value) <> 'string')
          when 'text' then jsonb_typeof(v_value) = 'string'
          when 'long-text' then jsonb_typeof(v_value) = 'string'
          when 'date' then jsonb_typeof(v_value) = 'string'
          when 'time' then jsonb_typeof(v_value) = 'string'
          when 'single-select' then jsonb_typeof(v_value) = 'string'
          when 'url' then jsonb_typeof(v_value) = 'string'
          else false
        end;
        if v_value is null or v_value = 'null'::jsonb or v_value = '""'::jsonb then
          v_field_valid := true;
          if p_record->>'outcome' = 'recorded' and coalesce((v_field->>'required')::boolean, false)
             and not v_existing_field then
            return jsonb_build_object('status', 'conflict', 'record', null);
          end if;
        end if;
        if not coalesce(v_field_valid, false) then return jsonb_build_object('status', 'conflict', 'record', null); end if;
        if v_field ? 'options' and v_field->'options' is not null
           and v_value is not null and v_value <> 'null'::jsonb and v_value <> '""'::jsonb then
          if v_field->>'type' = 'single-select'
             and not coalesce(v_field->'options' @> jsonb_build_array(v_value), false) then
            return jsonb_build_object('status', 'conflict', 'record', null);
          elsif v_field->>'type' = 'multi-select' and exists (
            select 1 from jsonb_array_elements(v_value) as option(value)
            where not coalesce(v_field->'options' @> jsonb_build_array(option.value), false)
          ) then
            return jsonb_build_object('status', 'conflict', 'record', null);
          end if;
        end if;
        continue;
      end if;

      -- Measure values must resolve to a measure available in the snapshot
      -- effective on this date.
      if v_tracker.schema_version <> 10 then continue; end if;
      select metric.value into v_metric
        from jsonb_array_elements(coalesce(v_definition->'metrics', '[]'::jsonb)) metric(value)
        where metric.value->>'id' = v_metric_id and metric.value->'retiredAt' is null;
      if not found then return jsonb_build_object('status', 'conflict', 'record', null); end if;
      v_metric_unchanged := v_has_existing_entry
        and coalesce(v_existing_entry.entry_values, '{}'::jsonb) ? v_metric_id
        and v_existing_entry.entry_values->v_metric_id is not distinct from v_value;
      v_metric_valid := (
        (v_metric->>'valueType' in ('quantity','duration') and jsonb_typeof(v_value) = 'number') or
        (v_metric->>'valueType' = 'boolean' and jsonb_typeof(v_value) = 'boolean') or
        (v_metric->>'valueType' = 'checklist' and jsonb_typeof(v_value) in ('array','object'))
      );
      -- Preserve a value already stored on this exact entry when editing its
      -- note or another field. New or changed values are strictly validated.
      if not v_metric_valid and not v_metric_unchanged then
        return jsonb_build_object('status', 'conflict', 'record', null);
      end if;
      if v_metric_unchanged then continue; end if;

      if v_metric->>'valueType' in ('quantity','duration') then
        if (v_value::text)::numeric < 0 then
          return jsonb_build_object('status', 'conflict', 'record', null);
        end if;
        begin
          v_increment := nullif(v_metric->'precision'->>'increment', '')::numeric;
          if v_increment is not null and (v_increment <= 0 or mod((v_value::text)::numeric, v_increment) <> 0) then
            return jsonb_build_object('status', 'conflict', 'record', null);
          end if;
        exception when others then
          return jsonb_build_object('status', 'conflict', 'record', null);
        end;
      elsif v_metric->>'valueType' = 'checklist' then
        if jsonb_typeof(v_value) = 'array' then
          -- Older v10 clients stored positional boolean arrays. Keep accepting
          -- that representation, but do not allow positions beyond the
          -- checklist effective on this entry date.
          if exists (
            select 1 from jsonb_array_elements(v_value) with ordinality as item(value, position)
            where jsonb_typeof(item.value) is distinct from 'boolean'
              or item.position > case when jsonb_typeof(v_metric->'checklistItems') = 'array'
                then jsonb_array_length(v_metric->'checklistItems') else 0 end
          ) then
            return jsonb_build_object('status', 'conflict', 'record', null);
          end if;
        else
          for v_checklist_item_id in select key from jsonb_object_keys(v_value) as item(key)
          loop
            if not exists (
              select 1 from jsonb_array_elements(coalesce(v_metric->'checklistItems', '[]'::jsonb)) as item(value)
              where item.value->>'id' = v_checklist_item_id
            ) or jsonb_typeof(v_value->v_checklist_item_id) is distinct from 'boolean' then
              return jsonb_build_object('status', 'conflict', 'record', null);
            end if;
          end loop;
        end if;
      end if;
    end loop;

    -- Required custom fields can be checked for new same-day entries because
    -- the current active definition is authoritative for today. Preserve a
    -- previously saved same-day omission/value unchanged for compatibility.
    -- Historical requiredness is unknown and is deliberately not reconstructed.
    if p_record->>'outcome' = 'recorded' and v_entry_date = v_workspace_today then
      for v_field in
        select field.value from jsonb_array_elements(coalesce(v_tracker.definition->'customFields', '[]'::jsonb)) as field(value)
        where coalesce((field.value->>'required')::boolean, false) and not (field.value ? 'retiredAt')
      loop
        v_field_id := 'field:' || (v_field->>'id');
        v_field_value := v_entry_values->v_field_id;
        v_existing_field := v_has_existing_entry
          and coalesce(v_existing_entry.entry_values, '{}'::jsonb) ? v_field_id;
        v_existing_field_value := case when v_existing_field
          then v_existing_entry.entry_values->v_field_id else null end;
        if (v_field_value is null or v_field_value = 'null'::jsonb or v_field_value = '""'::jsonb)
           and not (
             v_existing_field and v_existing_field_value is not distinct from v_field_value
             or v_has_existing_entry
               and not (coalesce(v_existing_entry.entry_values, '{}'::jsonb) ? v_field_id)
               and not (coalesce(v_entry_values, '{}'::jsonb) ? v_field_id)
           ) then
          return jsonb_build_object('status', 'conflict', 'record', null);
        end if;
      end loop;
    end if;
  end if;

  return public.apply_tracker_sync_operation_unchecked(
    p_expected_user_id, p_operation_id, p_entity, p_expected_revision, p_record
  );
end;
$$;

revoke all on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) from public, anon;
grant execute on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) to authenticated;
revoke all on function public.apply_tracker_sync_operation_unchecked(uuid, uuid, text, bigint, jsonb) from public, anon, authenticated;

comment on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) is
  'Serialized sync writer with recoverable server-side tracker boundary, milestone immutability, and date-effective measure validation.';

-- Tracker check-in XP uses its own award reconciler (rather than
-- reconcile_progression_award). Keep reversal source attribution intact when
-- a date-effective rule edit invalidates an existing check-in award.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure
  );
  v_old text := $old$    ) on conflict (user_id, idempotency_key) do nothing;
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,$old$;
  v_new text := $new$    ) on conflict (user_id, idempotency_key) do nothing;
    select * into v_event from public.progression_events
    where user_id = p_user_id and idempotency_key = md5('reverse:' || v_state.current_event_id::text)::uuid;
    insert into public.progression_event_sources(user_id, event_id, tracker_id, goal_id, source_id, display_name)
    select p_user_id, v_event.id, coalesce(original.tracker_id, p_tracker_id), original.goal_id,
      coalesce(original.source_id, p_entry_id), coalesce(original.display_name, v_tracker.name)
    from (select 1) as fallback
    left join public.progression_event_sources original
      on original.user_id = p_user_id and original.event_id = v_state.current_event_id
    where v_event.id is not null
    on conflict (user_id, event_id) do nothing;
    update public.progression_award_state set
      effective_date = p_entry_date, tracker_id = p_tracker_id, source_id = p_entry_id,$new$;
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected tracker check-in award reversal block was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

-- Repair older check-in reversals that predate this attribution guard. This
-- adds only the missing source relationship and leaves XP events untouched.
insert into public.progression_event_sources(user_id, event_id, tracker_id, goal_id, source_id, display_name)
select reversal.user_id, reversal.id, original.tracker_id, original.goal_id, original.source_id, original.display_name
from public.progression_events reversal
join public.progression_events award
  on award.user_id = reversal.user_id and award.id = reversal.reverses_event_id
join public.progression_event_sources original
  on original.user_id = award.user_id and original.event_id = award.id
where reversal.reason_code = 'AWARD_REVERSAL'
  and not exists (
    select 1 from public.progression_event_sources existing
    where existing.user_id = reversal.user_id and existing.event_id = reversal.id
  )
on conflict (user_id, event_id) do nothing;

commit;
