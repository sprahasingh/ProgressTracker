begin;

alter table public.ai_help_answer_feedback
  add column knowledge_decision text not null default 'not_decided'
    check (knowledge_decision in ('not_decided', 'create_candidate', 'no_knowledge_change')),
  add column knowledge_candidate_id uuid references public.ai_knowledge_candidates(id) on delete set null;

create table public.ai_help_answer_feedback_review_events (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.ai_help_answer_feedback(id) on delete cascade,
  action text not null check (action in ('status_changed', 'decision_changed', 'candidate_linked')),
  previous_status text check (previous_status is null or previous_status in ('pending', 'reviewed', 'resolved')),
  next_status text check (next_status is null or next_status in ('pending', 'reviewed', 'resolved')),
  previous_decision text check (previous_decision is null or previous_decision in ('not_decided', 'create_candidate', 'no_knowledge_change')),
  next_decision text check (next_decision is null or next_decision in ('not_decided', 'create_candidate', 'no_knowledge_change')),
  candidate_id uuid references public.ai_knowledge_candidates(id) on delete set null,
  reviewer_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index ai_help_answer_feedback_review_events_feedback_idx
  on public.ai_help_answer_feedback_review_events (feedback_id, created_at desc);

alter table public.ai_help_answer_feedback_review_events enable row level security;
revoke all on public.ai_help_answer_feedback_review_events from public, anon, authenticated;
grant all on public.ai_help_answer_feedback_review_events to service_role;

create or replace function public.review_unified_ai_answer_feedback(p_legacy_id uuid, p_status text, p_reviewer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_record public.ai_help_answer_feedback%rowtype;
  v_unified_id uuid;
  v_previous_status text;
begin
  if p_status is null or p_status not in ('pending', 'reviewed', 'resolved') or p_reviewer_id is null then
    raise exception 'Invalid feedback status.' using errcode = '22023';
  end if;
  select * into v_record from public.ai_help_answer_feedback where id = p_legacy_id for update;
  if not found then raise exception 'Feedback report not found.' using errcode = 'P0002'; end if;

  v_previous_status := v_record.status;
  update public.ai_help_answer_feedback set
    status = p_status,
    reviewed_at = case when p_status = 'pending' then null else now() end,
    reviewer_id = case when p_status = 'pending' then null else p_reviewer_id end
  where id = p_legacy_id returning * into v_record;

  insert into public.ai_help_answer_feedback_review_events
    (feedback_id, action, previous_status, next_status, previous_decision, next_decision, candidate_id, reviewer_id)
  values
    (p_legacy_id, 'status_changed', v_previous_status, p_status,
     v_record.knowledge_decision, v_record.knowledge_decision, v_record.knowledge_candidate_id, p_reviewer_id);

  select id into v_unified_id from public.support_feedback where metadata->>'legacy_answer_feedback_id' = p_legacy_id::text;
  if v_unified_id is not null then
    update public.support_feedback set
      status = case p_status when 'resolved' then 'resolved' when 'reviewed' then 'in_progress' else 'open' end,
      metadata = jsonb_set(metadata, '{legacy_status}', to_jsonb(p_status), true),
      maintainer_seen_at = case when p_status = 'pending' then null else now() end,
      maintainer_seen_by = case when p_status = 'pending' then null else p_reviewer_id end,
      updated_at = now(), last_activity_at = now()
    where id = v_unified_id;
  end if;
  return jsonb_build_object('id', v_record.id, 'status', v_record.status, 'reviewed_at', v_record.reviewed_at,
    'knowledge_decision', v_record.knowledge_decision, 'knowledge_candidate_id', v_record.knowledge_candidate_id);
end $$;

create or replace function public.set_ai_help_answer_feedback_knowledge_decision(
  p_feedback_id uuid, p_decision text, p_reviewer_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_record public.ai_help_answer_feedback%rowtype;
  v_previous_decision text;
begin
  if p_decision is null or p_decision not in ('not_decided', 'create_candidate', 'no_knowledge_change') or p_reviewer_id is null then
    raise exception 'Invalid feedback knowledge decision.' using errcode = '22023';
  end if;
  select * into v_record from public.ai_help_answer_feedback where id = p_feedback_id for update;
  if not found then raise exception 'Feedback report not found.' using errcode = 'P0002'; end if;
  v_previous_decision := v_record.knowledge_decision;
  update public.ai_help_answer_feedback set knowledge_decision = p_decision
    where id = p_feedback_id returning * into v_record;
  if v_previous_decision is distinct from p_decision then
    insert into public.ai_help_answer_feedback_review_events
      (feedback_id, action, previous_status, next_status, previous_decision, next_decision, candidate_id, reviewer_id)
    values (p_feedback_id, 'decision_changed', v_record.status, v_record.status, v_previous_decision, p_decision,
      v_record.knowledge_candidate_id, p_reviewer_id);
  end if;
  return jsonb_build_object('id', v_record.id, 'status', v_record.status,
    'knowledge_decision', v_record.knowledge_decision, 'knowledge_candidate_id', v_record.knowledge_candidate_id);
end $$;

create or replace function public.create_ai_help_answer_feedback_candidate(
  p_feedback_id uuid,
  p_reviewer_id uuid,
  p_topic_id text,
  p_title text,
  p_explanation text,
  p_detailed_explanation text,
  p_feature_category text,
  p_source_refs jsonb,
  p_source_fingerprints jsonb,
  p_knowledge_version text,
  p_candidate_fingerprint text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feedback public.ai_help_answer_feedback%rowtype;
  v_result jsonb;
  v_candidate_id uuid;
  v_previous_decision text;
begin
  if p_reviewer_id is null then raise exception 'Maintainer identity is required.' using errcode = '22023'; end if;
  select * into v_feedback from public.ai_help_answer_feedback where id = p_feedback_id for update;
  if not found then raise exception 'Feedback report not found.' using errcode = 'P0002'; end if;

  if v_feedback.knowledge_candidate_id is not null then
    v_previous_decision := v_feedback.knowledge_decision;
    update public.ai_help_answer_feedback set knowledge_decision = 'create_candidate' where id = p_feedback_id returning * into v_feedback;
    if v_previous_decision is distinct from 'create_candidate' then
      insert into public.ai_help_answer_feedback_review_events
        (feedback_id, action, previous_status, next_status, previous_decision, next_decision, candidate_id, reviewer_id)
      values (p_feedback_id, 'candidate_linked', v_feedback.status, v_feedback.status,
        v_previous_decision, 'create_candidate', v_feedback.knowledge_candidate_id, p_reviewer_id);
    end if;
    return jsonb_build_object('candidate_id', v_feedback.knowledge_candidate_id, 'created', false, 'duplicate', true);
  end if;

  v_previous_decision := v_feedback.knowledge_decision;
  v_result := public.submit_ai_knowledge_candidate(
    p_topic_id, p_title, p_explanation, p_detailed_explanation, p_feature_category,
    p_source_refs, p_source_fingerprints, p_knowledge_version, p_candidate_fingerprint
  );
  if v_result ? 'candidate_id' then v_candidate_id := (v_result->>'candidate_id')::uuid; end if;
  if v_candidate_id is null then
    select id into v_candidate_id from public.ai_knowledge_candidates
      where candidate_fingerprint = p_candidate_fingerprint and knowledge_version = p_knowledge_version and status = 'pending'
      limit 1;
  end if;
  if v_candidate_id is null then
    raise exception 'An approved knowledge topic already exists for this subject.' using errcode = '23505';
  end if;

  update public.ai_help_answer_feedback set
    knowledge_decision = 'create_candidate', knowledge_candidate_id = v_candidate_id
  where id = p_feedback_id returning * into v_feedback;
  insert into public.ai_help_answer_feedback_review_events
    (feedback_id, action, previous_status, next_status, previous_decision, next_decision, candidate_id, reviewer_id)
  values (p_feedback_id, 'candidate_linked', v_feedback.status, v_feedback.status,
    v_previous_decision, 'create_candidate', v_candidate_id, p_reviewer_id);
  return jsonb_build_object('candidate_id', v_candidate_id, 'created', coalesce((v_result->>'created')::boolean, false),
    'duplicate', coalesce((v_result->>'duplicate')::boolean, false));
end $$;

revoke all on function public.review_unified_ai_answer_feedback(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.set_ai_help_answer_feedback_knowledge_decision(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.create_ai_help_answer_feedback_candidate(uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.review_unified_ai_answer_feedback(uuid, text, uuid) to service_role;
grant execute on function public.set_ai_help_answer_feedback_knowledge_decision(uuid, text, uuid) to service_role;
grant execute on function public.create_ai_help_answer_feedback_candidate(uuid, uuid, text, text, text, text, text, jsonb, jsonb, text, text) to service_role;

commit;
