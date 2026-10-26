begin;

-- Treat threshold fields as evaluation policy while keeping all other measure
-- metadata structural. The tracker definition and its v10 snapshots remain the
-- sole version history; no new row store or data backfill is needed.
create or replace function public.tracker_edit_metrics_without_thresholds(p_metrics jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(metric.value - 'thresholds' order by metric.position), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_metrics, '[]'::jsonb)) with ordinality as metric(value, position)
$$;
revoke all on function public.tracker_edit_metrics_without_thresholds(jsonb) from public, anon, authenticated, service_role;

create or replace function public.tracker_edit_evaluation_without_thresholds(p_evaluation jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_evaluation, '{}'::jsonb) || jsonb_build_object(
    'metrics', public.tracker_edit_metrics_without_thresholds(p_evaluation->'metrics')
  )
$$;
revoke all on function public.tracker_edit_evaluation_without_thresholds(jsonb) from public, anon, authenticated, service_role;

-- Extend the existing owner-checked sync RPC in place. Threshold changes still
-- require a new effective version, but may use all-history or today's date;
-- changes to measure identity/type/unit/precision/checklist shape remain guarded.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure);
  v_updated text;
  v_pattern text;
  v_replacement text;
  v_matches integer;
begin
  v_pattern := $pattern$coalesce\(p_record->'definition'->'metrics', '\[\]'::jsonb\)[[:space:]]+is distinct from[[:space:]]+coalesce\(v_tracker\.definition->'metrics', '\[\]'::jsonb\)$pattern$;
  v_replacement := $replacement$public.tracker_edit_metrics_without_thresholds(p_record->'definition'->'metrics') is distinct from public.tracker_edit_metrics_without_thresholds(v_tracker.definition->'metrics')$replacement$;
  select count(*) into v_matches from regexp_matches(v_definition, v_pattern, 'g');
  if v_matches <> 4 then
    raise exception 'Expected tracker metric comparison was not found in apply_tracker_sync_operation';
  end if;
  v_updated := regexp_replace(v_definition, v_pattern, v_replacement, 'g');

  v_pattern := $pattern$v_historical_metric->'thresholds',$pattern$;
  if pg_catalog.strpos(v_updated, v_pattern) = 0 then
    raise exception 'Expected historical measure signature was not found in apply_tracker_sync_operation';
  end if;
  v_updated := pg_catalog.replace(v_updated, v_pattern, '');

  v_pattern := $pattern$v_proposed_metric->'thresholds',$pattern$;
  if pg_catalog.strpos(v_updated, v_pattern) = 0 then
    raise exception 'Expected proposed measure signature was not found in apply_tracker_sync_operation';
  end if;
  v_updated := pg_catalog.replace(v_updated, v_pattern, '');

  v_pattern := $pattern$[[:space:]]*-- Successful-day and streak milestones directly depend on historical
        -- rules; their definitions are not date-versioned, so preserve them\.
        if exists \(
          select 1 from jsonb_array_elements\(coalesce\(v_tracker\.definition->'milestones','\[\]'::jsonb\)\) milestone\(value\)
          where milestone\.value->>'type' in \('successful-days','streak-length'\)
        \) then
          return jsonb_build_object\('status', 'conflict', 'record', to_jsonb\(v_tracker\)\);
        end if;[[:space:]]*$pattern$;
  select count(*) into v_matches from regexp_matches(v_updated, v_pattern, 'g');
  if v_matches <> 1 then
    raise exception 'Expected historical milestone guard was not found in apply_tracker_sync_operation';
  end if;
  v_replacement := $replacement$
        if exists (
          select 1 from jsonb_array_elements(coalesce(v_tracker.definition->'milestones','[]'::jsonb)) milestone(value)
          where milestone.value->>'type' in ('successful-days','streak-length')
        ) and public.tracker_edit_evaluation_without_thresholds(
          p_record->'definition'->'ruleVersions'->-1->'evaluation'
        ) is distinct from public.tracker_edit_evaluation_without_thresholds(
          v_tracker.definition->'ruleVersions'->-1->'evaluation'
        ) then
          return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
        end if;
$replacement$;
  v_updated := regexp_replace(v_updated, v_pattern, v_replacement, 'g');

  execute v_updated;
end;
$$;

-- The preexisting history trigger also froze the entire threshold object as
-- measure meaning. Keep its identity/type/unit/checklist protection, but let
-- date-versioned threshold policy change through that same guard.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.guard_tracker_metric_integrity()'::regprocedure);
  v_old text := $old$(v_old_metric - 'retiredAt' - 'precision') is distinct from (v_new_metric - 'retiredAt' - 'precision')$old$;
  v_new text := $new$(v_old_metric - 'retiredAt' - 'precision' - 'thresholds') is distinct from (v_new_metric - 'retiredAt' - 'precision' - 'thresholds')$new$;
begin
  if length(v_definition) - length(pg_catalog.replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'Expected saved-history measure integrity check was not found exactly once';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

-- Version the sync contract so clients can distinguish threshold-aware guards
-- from the earlier structural-only edit contract. Older clients fail closed.
create or replace function public.tracker_edit_sync_guards_contract()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.uid() is null then null else 'tracker-edit-sync-guards:v2' end
$$;
revoke all on function public.tracker_edit_sync_guards_contract() from public, anon;
grant execute on function public.tracker_edit_sync_guards_contract() to authenticated;

commit;
