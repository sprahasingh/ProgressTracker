-- All-history threshold edits collapse rule snapshots. Preserve numeric input
-- semantics by requiring precision to match every historical dependency.
-- Forward-effective precision changes remain supported by the existing v10
-- rule-version policy and saved-value protections.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure
  );
  v_old text := $old$jsonb_build_array(v_historical_metric->>'id',v_historical_metric->>'name',v_historical_metric->>'valueType',
                    v_historical_metric->'unit',v_historical_metric->'checklistItems')
                  is distinct from
                  jsonb_build_array(v_proposed_metric->>'id',v_proposed_metric->>'name',v_proposed_metric->>'valueType',
                    v_proposed_metric->'unit',v_proposed_metric->'checklistItems')$old$;
  v_new text := $new$jsonb_build_array(v_historical_metric->>'id',v_historical_metric->>'name',v_historical_metric->>'valueType',
                    v_historical_metric->'unit',v_historical_metric->'precision',v_historical_metric->'checklistItems')
                  is distinct from
                  jsonb_build_array(v_proposed_metric->>'id',v_proposed_metric->>'name',v_proposed_metric->>'valueType',
                    v_proposed_metric->'unit',v_proposed_metric->'precision',v_proposed_metric->'checklistItems')$new$;
  v_dependency_old text := $old$          where section.key in ('progressSemantics','dailyTargets','cumulativeTargets','allocations','manualAllocations')
        loop$old$;
  v_dependency_new text := $new$          where section.key in ('progressSemantics','dailyTargets','cumulativeTargets','allocations','manualAllocations')
          union
          select proposed_metric.value->>'id'
          from jsonb_array_elements(coalesce(p_record->'definition'->'metrics','[]'::jsonb)) proposed_metric(value)
          join jsonb_array_elements(coalesce(v_tracker.definition->'metrics','[]'::jsonb)) current_metric(value)
            on current_metric.value->>'id' = proposed_metric.value->>'id'
          where current_metric.value->'thresholds' is distinct from proposed_metric.value->'thresholds'
        loop$new$;
  v_updated text;
begin
  if pg_catalog.strpos(v_definition, v_old) = 0
     or pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_old, ''))
        <> pg_catalog.length(v_old) then
    raise exception 'Expected historical metric compatibility check was not found exactly once';
  end if;

  v_updated := pg_catalog.replace(v_definition, v_old, v_new);
  if pg_catalog.strpos(v_updated, v_dependency_old) = 0
     or pg_catalog.length(v_updated) - pg_catalog.length(pg_catalog.replace(v_updated, v_dependency_old, ''))
        <> pg_catalog.length(v_dependency_old) then
    raise exception 'Expected all-history dependency loop was not found exactly once';
  end if;

  execute pg_catalog.replace(v_updated, v_dependency_old, v_dependency_new);
end;
$$;
