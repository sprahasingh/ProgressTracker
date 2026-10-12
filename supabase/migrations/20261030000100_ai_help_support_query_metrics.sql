begin;

-- Add content-free aggregate outcomes for explicit AI Help escalations.
alter table public.ai_help_learning_metrics drop constraint if exists ai_help_learning_metrics_event_check;
alter table public.ai_help_learning_metrics add constraint ai_help_learning_metrics_event_check
  check (event in (
    'request', 'source_fallback', 'verified_knowledge_used', 'candidate_created', 'candidate_skipped', 'candidate_rejected',
    'candidate_persistence_failure', 'duplicate_skipped', 'approved', 'rejected', 'stale_entry',
    'grounding_failure', 'retrieval_no_match', 'provider_failure', 'conflicting_knowledge', 'feedback_created', 'feedback_failed',
    'support_query_accepted', 'support_query_failed', 'support_query_uncertain'
  ));

create or replace function public.record_ai_help_metric(p_event text, p_feature_category text default 'other')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category text := lower(coalesce(nullif(p_feature_category, ''), 'other'));
begin
  if p_event not in (
    'request', 'source_fallback', 'verified_knowledge_used', 'candidate_created', 'candidate_skipped', 'candidate_rejected',
    'candidate_persistence_failure', 'duplicate_skipped', 'approved', 'rejected', 'stale_entry',
    'grounding_failure', 'retrieval_no_match', 'provider_failure', 'conflicting_knowledge', 'feedback_created', 'feedback_failed',
    'support_query_accepted', 'support_query_failed', 'support_query_uncertain'
  ) then
    raise exception 'Invalid AI Help metric event.' using errcode = '22023';
  end if;
  if v_category !~ '^(core|trackers|goals|schedules|history|analytics|sync|privacy|account|notifications|settings|other)$' then
    v_category := 'other';
  end if;
  insert into public.ai_help_learning_metrics (metric_date, event, feature_category, event_count)
  values (current_date, p_event, v_category, 1)
  on conflict (metric_date, event, feature_category) do update
    set event_count = public.ai_help_learning_metrics.event_count + 1, updated_at = now();
end;
$$;

revoke all on function public.record_ai_help_metric(text, text) from public, anon, authenticated;
grant execute on function public.record_ai_help_metric(text, text) to service_role;

commit;
