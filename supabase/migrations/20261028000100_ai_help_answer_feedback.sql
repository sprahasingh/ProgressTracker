-- Privacy-limited answer feedback and bounded, aggregate AI Help diagnostics.
begin;

alter table public.ai_help_learning_metrics drop constraint if exists ai_help_learning_metrics_event_check;
alter table public.ai_help_learning_metrics add constraint ai_help_learning_metrics_event_check
  check (event in (
    'request', 'source_fallback', 'verified_knowledge_used', 'candidate_created', 'candidate_skipped', 'candidate_rejected',
    'candidate_persistence_failure', 'duplicate_skipped', 'approved', 'rejected', 'stale_entry',
    'grounding_failure', 'retrieval_no_match', 'provider_failure', 'conflicting_knowledge', 'feedback_created', 'feedback_failed'
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
    'grounding_failure', 'retrieval_no_match', 'provider_failure', 'conflicting_knowledge', 'feedback_created', 'feedback_failed'
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

create table public.ai_help_answer_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  response_id uuid not null,
  category text not null check (category in ('helpful', 'factually_incorrect', 'outdated', 'wrong_instructions', 'wrong_contact', 'other')),
  explanation text check (explanation is null or length(explanation) <= 400),
  topic text not null check (topic in ('core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other')),
  knowledge_version text not null check (length(knowledge_version) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'resolved')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '180 days'),
  unique (user_id, response_id),
  check (explanation is null or explanation !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'),
  check (explanation is null or explanation !~* '(password|token|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]+'),
  check (explanation is null or explanation !~* 'bearer[[:space:]]+[^[:space:]]+')
);

create index ai_help_answer_feedback_status_created_idx
  on public.ai_help_answer_feedback (status, created_at desc);
create index ai_help_answer_feedback_expires_idx
  on public.ai_help_answer_feedback (expires_at);

create table public.ai_help_feedback_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  report_count smallint not null check (report_count between 1 and 11)
);

alter table public.ai_help_answer_feedback enable row level security;
alter table public.ai_help_feedback_rate_limits enable row level security;
revoke all on public.ai_help_answer_feedback, public.ai_help_feedback_rate_limits from public, anon, authenticated;
grant all on public.ai_help_answer_feedback, public.ai_help_feedback_rate_limits to service_role;

create or replace function public.submit_ai_help_answer_feedback(
  p_user_id uuid,
  p_response_id uuid,
  p_category text,
  p_explanation text,
  p_topic text,
  p_knowledge_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_report_count smallint;
  v_feedback_id uuid;
  v_duplicate boolean := false;
begin
  if p_user_id is null or p_response_id is null
    or p_category not in ('helpful', 'factually_incorrect', 'outdated', 'wrong_instructions', 'wrong_contact', 'other')
    or p_topic not in ('core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other')
    or p_knowledge_version is null or length(p_knowledge_version) not between 1 and 100
    or (p_explanation is not null and (length(p_explanation) > 400
      or p_explanation ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
      or p_explanation ~* '(password|token|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]+'
      or p_explanation ~* 'bearer[[:space:]]+[^[:space:]]+'
      or p_explanation ~* 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')) then
    raise exception 'Invalid answer feedback.' using errcode = '22023';
  end if;

  delete from public.ai_help_answer_feedback where expires_at <= v_now;
  delete from public.ai_help_feedback_rate_limits where window_started_at <= v_now - interval '1 day';
  insert into public.ai_help_feedback_rate_limits as rate_limit(user_id, window_started_at, report_count)
  values (p_user_id, v_now, 1)
  on conflict (user_id) do update set
    window_started_at = case when rate_limit.window_started_at <= v_now - interval '15 minutes' then v_now else rate_limit.window_started_at end,
    report_count = case when rate_limit.window_started_at <= v_now - interval '15 minutes' then 1 else least(rate_limit.report_count + 1, 11) end
  returning report_count into v_report_count;
  if v_report_count > 10 then
    raise exception 'AI Help feedback rate limited.' using errcode = 'P4290';
  end if;

  insert into public.ai_help_answer_feedback(user_id, response_id, category, explanation, topic, knowledge_version, expires_at)
  values (p_user_id, p_response_id, p_category, nullif(btrim(p_explanation), ''), p_topic, p_knowledge_version, v_now + interval '180 days')
  on conflict (user_id, response_id) do nothing
  returning id into v_feedback_id;
  if v_feedback_id is null then
    v_duplicate := true;
    select id into v_feedback_id from public.ai_help_answer_feedback where user_id = p_user_id and response_id = p_response_id;
  else
    perform public.record_ai_help_metric('feedback_created', p_topic);
  end if;
  return jsonb_build_object('accepted', true, 'duplicate', v_duplicate, 'feedback_id', v_feedback_id);
end;
$$;

create or replace function public.invalidate_ai_verified_knowledge(
  p_topic_id text,
  p_reviewer_id uuid,
  p_expected_reviewed_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.ai_verified_knowledge%rowtype;
begin
  if p_topic_id is null or p_reviewer_id is null or p_expected_reviewed_at is null
    or p_reason is null or length(btrim(p_reason)) not between 8 and 300 then
    raise exception 'A topic and brief review reason are required.' using errcode = '22023';
  end if;
  select * into v_entry from public.ai_verified_knowledge where topic_id = p_topic_id for update;
  if not found then raise exception 'Verified topic was not found.' using errcode = 'P0002'; end if;
  if v_entry.status <> 'verified' or v_entry.reviewed_at is distinct from p_expected_reviewed_at then
    raise exception 'Verified topic changed. Refresh and try again.' using errcode = '40001';
  end if;
  update public.ai_verified_knowledge set status = 'stale', stale_at = now(), updated_at = now() where topic_id = p_topic_id;
  insert into public.ai_knowledge_review_events(topic_id, action, previous_status, next_status, reviewer_id, metadata)
  values (p_topic_id, 'marked_stale', 'verified', 'stale', p_reviewer_id, jsonb_build_object('reason', btrim(p_reason), 'source', 'maintainer_feedback_review'));
  perform public.record_ai_help_metric('stale_entry', v_entry.feature_category);
  return jsonb_build_object('status', 'stale', 'topic_id', p_topic_id);
end;
$$;

revoke all on function public.submit_ai_help_answer_feedback(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_ai_help_answer_feedback(uuid, uuid, text, text, text, text) to service_role;
revoke all on function public.invalidate_ai_verified_knowledge(text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.invalidate_ai_verified_knowledge(text, uuid, timestamptz, text) to service_role;

commit;
