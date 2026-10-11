-- Harden candidate growth and reconcile duplicate topics safely across bundle
-- versions. A stale verified topic may be queued for explicit revalidation.
alter table public.ai_knowledge_review_events drop constraint if exists ai_knowledge_review_events_action_check;
alter table public.ai_knowledge_review_events add constraint ai_knowledge_review_events_action_check
  check (action in ('created', 'duplicate_skipped', 'candidate_skipped', 'edited', 'approved', 'rejected', 'deferred', 'marked_stale'));
alter table public.ai_help_learning_metrics drop constraint if exists ai_help_learning_metrics_event_check;
alter table public.ai_help_learning_metrics add constraint ai_help_learning_metrics_event_check
  check (event in ('request', 'source_fallback', 'verified_knowledge_used', 'candidate_created', 'candidate_skipped', 'duplicate_skipped', 'approved', 'rejected', 'stale_entry', 'grounding_failure'));

create or replace function public.record_ai_help_metric(p_event text, p_feature_category text default 'other')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category text := lower(coalesce(nullif(p_feature_category, ''), 'other'));
begin
  if p_event not in ('request', 'source_fallback', 'verified_knowledge_used', 'candidate_created', 'candidate_skipped', 'duplicate_skipped', 'approved', 'rejected', 'stale_entry', 'grounding_failure') then
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

create or replace function public.submit_ai_knowledge_candidate(
  p_topic_id text,
  p_title text,
  p_explanation text,
  p_detailed_explanation text,
  p_feature_category text,
  p_source_refs jsonb,
  p_source_fingerprints jsonb,
  p_knowledge_version text,
  p_candidate_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing_status text;
  v_inserted boolean := false;
begin
  if p_topic_id is null or p_title is null or p_explanation is null or p_feature_category is null
    or p_source_refs is null or p_source_fingerprints is null or p_knowledge_version is null or p_candidate_fingerprint is null
    or p_topic_id !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    or length(p_title) not between 5 and 120
    or length(p_explanation) not between 40 and 1200
    or (p_detailed_explanation is not null and length(p_detailed_explanation) > 2400)
    or p_feature_category not in ('core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other')
    or jsonb_typeof(p_source_refs) <> 'array' or jsonb_array_length(p_source_refs) = 0
    or jsonb_typeof(p_source_fingerprints) <> 'object' or p_source_fingerprints = '{}'::jsonb
    or p_knowledge_version = '' or p_candidate_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid verified knowledge candidate.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ai_knowledge_candidate_capacity', 0));

  select status into v_existing_status from public.ai_verified_knowledge where topic_id = p_topic_id;
  if found and v_existing_status = 'verified' then
    perform public.record_ai_help_metric('duplicate_skipped', p_feature_category);
    return jsonb_build_object('created', false, 'duplicate', true, 'reason', 'verified_topic_exists');
  end if;

  select id into v_id from public.ai_knowledge_candidates
  where topic_id = p_topic_id and knowledge_version = p_knowledge_version and status = 'pending' limit 1;
  if found then
    perform public.record_ai_help_metric('duplicate_skipped', p_feature_category);
    return jsonb_build_object('created', false, 'duplicate', true, 'candidate_id', v_id);
  end if;

  if (select count(*) from public.ai_knowledge_candidates) >= 5000 then
    perform public.record_ai_help_metric('candidate_skipped', p_feature_category);
    return jsonb_build_object('created', false, 'duplicate', false, 'reason', 'candidate_storage_capacity_reached');
  end if;

  begin
    insert into public.ai_knowledge_candidates (
      candidate_fingerprint, answer, source_refs, knowledge_version, status,
      topic_id, title, explanation, detailed_explanation, feature_category, source_fingerprints
    ) values (
      p_candidate_fingerprint, p_explanation, p_source_refs, p_knowledge_version, 'pending',
      p_topic_id, p_title, p_explanation, p_detailed_explanation, p_feature_category, p_source_fingerprints
    ) on conflict (candidate_fingerprint, knowledge_version) where status = 'pending'
      do nothing returning id into v_id;
    v_inserted := v_id is not null;
  exception when unique_violation then
    v_inserted := false;
  end;

  if not v_inserted then
    perform public.record_ai_help_metric('duplicate_skipped', p_feature_category);
    return jsonb_build_object('created', false, 'duplicate', true);
  end if;

  perform public.record_ai_help_metric('candidate_created', p_feature_category);
  insert into public.ai_knowledge_review_events (candidate_id, topic_id, action, next_status)
  values (v_id, p_topic_id, 'created', 'pending');
  return jsonb_build_object('created', true, 'duplicate', false, 'candidate_id', v_id);
end;
$$;

create or replace function public.reconcile_ai_knowledge(p_current_fingerprints jsonb, p_knowledge_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verified_stale integer := 0;
  v_candidate_stale integer := 0;
  v_candidate_duplicates integer := 0;
begin
  if p_current_fingerprints is null or jsonb_typeof(p_current_fingerprints) <> 'object' or p_knowledge_version is null or p_knowledge_version = '' then
    raise exception 'Invalid AI Help evidence manifest.' using errcode = '22023';
  end if;

  update public.ai_verified_knowledge knowledge
  set status = 'stale', stale_at = coalesce(stale_at, now()), updated_at = now()
  where status = 'verified' and (
    jsonb_typeof(source_fingerprints) <> 'object' or source_fingerprints = '{}'::jsonb or exists (
      select 1 from jsonb_each(knowledge.source_fingerprints) fingerprint
      where p_current_fingerprints -> fingerprint.key is distinct from fingerprint.value
    )
  );
  get diagnostics v_verified_stale = row_count;

  update public.ai_verified_knowledge
  set knowledge_version = p_knowledge_version, updated_at = now()
  where status = 'verified' and knowledge_version is distinct from p_knowledge_version;

  with eligible as (
    select candidate.id,
      row_number() over (partition by candidate.topic_id order by (candidate.knowledge_version = p_knowledge_version) desc, candidate.created_at, candidate.id) as duplicate_rank
    from public.ai_knowledge_candidates candidate
    where candidate.status = 'pending'
      and jsonb_typeof(candidate.source_fingerprints) = 'object'
      and candidate.source_fingerprints <> '{}'::jsonb
      and not exists (
        select 1 from jsonb_each(case when jsonb_typeof(candidate.source_fingerprints) = 'object' then candidate.source_fingerprints else '{}'::jsonb end) fingerprint
        where p_current_fingerprints -> fingerprint.key is distinct from fingerprint.value
      )
  )
  update public.ai_knowledge_candidates candidate
  set status = 'stale', updated_at = now()
  from eligible where candidate.id = eligible.id and eligible.duplicate_rank > 1;
  get diagnostics v_candidate_duplicates = row_count;

  update public.ai_knowledge_candidates candidate
  set status = 'stale', updated_at = now()
  where status = 'pending' and (
    jsonb_typeof(source_fingerprints) <> 'object' or source_fingerprints = '{}'::jsonb or exists (
      select 1 from jsonb_each(case when jsonb_typeof(candidate.source_fingerprints) = 'object' then candidate.source_fingerprints else '{}'::jsonb end) fingerprint
      where p_current_fingerprints -> fingerprint.key is distinct from fingerprint.value
    )
  );
  get diagnostics v_candidate_stale = row_count;

  update public.ai_knowledge_candidates
  set knowledge_version = p_knowledge_version, updated_at = now()
  where status = 'pending' and knowledge_version is distinct from p_knowledge_version;

  if v_candidate_duplicates > 0 then
    insert into public.ai_knowledge_review_events (action, metadata)
    values ('duplicate_skipped', jsonb_build_object('stale_duplicate_candidates', v_candidate_duplicates, 'reason', 'same_topic_after_bundle_reconciliation'));
  end if;
  if v_verified_stale + v_candidate_stale + v_candidate_duplicates > 0 then
    perform public.record_ai_help_metric('stale_entry', 'other');
  end if;
  if v_verified_stale + v_candidate_stale + v_candidate_duplicates > 0 then
    insert into public.ai_knowledge_review_events (action, metadata)
    values ('marked_stale', jsonb_build_object('verified_count', v_verified_stale, 'candidate_count', v_candidate_stale, 'duplicate_candidate_count', v_candidate_duplicates, 'knowledge_version', p_knowledge_version));
  end if;
  return jsonb_build_object('verified_stale', v_verified_stale, 'candidates_stale', v_candidate_stale, 'duplicate_candidates_stale', v_candidate_duplicates);
end;
$$;

create or replace function public.review_ai_knowledge_candidate(
  p_candidate_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_expected_updated_at timestamptz default null,
  p_topic_id text default null,
  p_title text default null,
  p_explanation text default null,
  p_detailed_explanation text default null,
  p_feature_category text default null,
  p_source_refs jsonb default null,
  p_source_fingerprints jsonb default null,
  p_knowledge_version text default null,
  p_candidate_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.ai_knowledge_candidates%rowtype;
  v_previous_verified jsonb;
  v_candidate_snapshot jsonb;
begin
  if p_action not in ('edit', 'approve', 'reject', 'defer') then
    raise exception 'Unsupported review action.' using errcode = '22023';
  end if;
  select * into v_candidate from public.ai_knowledge_candidates where id = p_candidate_id for update;
  if not found then raise exception 'Candidate no longer exists.' using errcode = 'P0002'; end if;
  if v_candidate.status not in ('pending', 'stale') then raise exception 'Candidate has already been reviewed.' using errcode = '40001'; end if;
  if p_expected_updated_at is not null and v_candidate.updated_at is distinct from p_expected_updated_at then
    raise exception 'Candidate changed while it was being reviewed. Refresh and try again.' using errcode = '40001';
  end if;

  v_candidate_snapshot := jsonb_build_object(
    'topic_id', v_candidate.topic_id, 'title', v_candidate.title, 'explanation', v_candidate.explanation,
    'detailed_explanation', v_candidate.detailed_explanation, 'feature_category', v_candidate.feature_category,
    'source_refs', v_candidate.source_refs, 'source_fingerprints', v_candidate.source_fingerprints,
    'knowledge_version', v_candidate.knowledge_version
  );

  if p_action = 'defer' then
    insert into public.ai_knowledge_review_events (candidate_id, topic_id, action, previous_status, next_status, reviewer_id)
    values (v_candidate.id, v_candidate.topic_id, 'deferred', v_candidate.status, v_candidate.status, p_reviewer_id);
    return jsonb_build_object('status', v_candidate.status, 'updated_at', v_candidate.updated_at);
  end if;

  if p_action = 'reject' then
    update public.ai_knowledge_candidates set status = 'rejected', reviewer_id = p_reviewer_id, reviewed_at = now(), updated_at = now()
    where id = v_candidate.id;
    insert into public.ai_knowledge_review_events (candidate_id, topic_id, action, previous_status, next_status, reviewer_id, metadata)
    values (v_candidate.id, v_candidate.topic_id, 'rejected', v_candidate.status, 'rejected', p_reviewer_id,
      jsonb_build_object('candidate_snapshot', v_candidate_snapshot));
    perform public.record_ai_help_metric('rejected', coalesce(v_candidate.feature_category, 'other'));
    return jsonb_build_object('status', 'rejected');
  end if;

  if p_topic_id is null or p_title is null or p_explanation is null or p_feature_category is null
    or p_source_refs is null or p_source_fingerprints is null or p_knowledge_version is null or p_candidate_fingerprint is null
    or p_topic_id !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    or length(p_title) not between 5 and 120
    or length(p_explanation) not between 40 and 1200
    or (p_detailed_explanation is not null and length(p_detailed_explanation) > 2400)
    or p_feature_category not in ('core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other')
    or jsonb_typeof(p_source_refs) <> 'array' or jsonb_array_length(p_source_refs) = 0
    or jsonb_typeof(p_source_fingerprints) <> 'object' or p_source_fingerprints = '{}'::jsonb
    or p_knowledge_version = '' or p_candidate_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Candidate content or evidence is invalid.' using errcode = '22023';
  end if;

  if p_action = 'edit' then
    update public.ai_knowledge_candidates set
      candidate_fingerprint = p_candidate_fingerprint, answer = p_explanation, topic_id = p_topic_id,
      title = p_title, explanation = p_explanation, detailed_explanation = p_detailed_explanation,
      feature_category = p_feature_category, source_refs = p_source_refs, source_fingerprints = p_source_fingerprints,
      knowledge_version = p_knowledge_version, status = 'pending', updated_at = now()
    where id = v_candidate.id;
    insert into public.ai_knowledge_review_events (candidate_id, topic_id, action, previous_status, next_status, reviewer_id, metadata)
    values (v_candidate.id, p_topic_id, 'edited', v_candidate.status, 'pending', p_reviewer_id,
      jsonb_build_object('knowledge_version', p_knowledge_version, 'previous_candidate', v_candidate_snapshot,
        'edited_candidate', jsonb_build_object('topic_id', p_topic_id, 'title', p_title, 'explanation', p_explanation,
          'detailed_explanation', p_detailed_explanation, 'feature_category', p_feature_category,
          'source_refs', p_source_refs, 'source_fingerprints', p_source_fingerprints)));
    return jsonb_build_object('status', 'pending');
  end if;

  select to_jsonb(knowledge) into v_previous_verified from public.ai_verified_knowledge knowledge where topic_id = p_topic_id;
  insert into public.ai_verified_knowledge (
    topic_id, title, explanation, detailed_explanation, feature_category, source_refs,
    source_fingerprints, knowledge_version, status, candidate_id, reviewed_at, stale_at, reviewer_id, updated_at
  ) values (
    p_topic_id, p_title, p_explanation, p_detailed_explanation, p_feature_category, p_source_refs,
    p_source_fingerprints, p_knowledge_version, 'verified', v_candidate.id, now(), null, p_reviewer_id, now()
  ) on conflict (topic_id) do update set
    title = excluded.title, explanation = excluded.explanation, detailed_explanation = excluded.detailed_explanation,
    feature_category = excluded.feature_category, source_refs = excluded.source_refs,
    source_fingerprints = excluded.source_fingerprints, knowledge_version = excluded.knowledge_version,
    status = 'verified', candidate_id = excluded.candidate_id, reviewed_at = now(), stale_at = null,
    reviewer_id = p_reviewer_id, updated_at = now();

  update public.ai_knowledge_candidates set
    candidate_fingerprint = p_candidate_fingerprint, answer = p_explanation, topic_id = p_topic_id,
    title = p_title, explanation = p_explanation, detailed_explanation = p_detailed_explanation,
    feature_category = p_feature_category, source_refs = p_source_refs, source_fingerprints = p_source_fingerprints,
    knowledge_version = p_knowledge_version, status = 'verified', reviewer_id = p_reviewer_id, reviewed_at = now(), updated_at = now()
  where id = v_candidate.id;
  insert into public.ai_knowledge_review_events (candidate_id, topic_id, action, previous_status, next_status, reviewer_id, metadata)
  values (v_candidate.id, p_topic_id, 'approved', v_candidate.status, 'verified', p_reviewer_id,
    jsonb_build_object('knowledge_version', p_knowledge_version, 'replaced_verified_entry', v_previous_verified is not null,
      'prior_verified_entry', v_previous_verified, 'approved_candidate', jsonb_build_object('topic_id', p_topic_id,
        'title', p_title, 'explanation', p_explanation, 'detailed_explanation', p_detailed_explanation,
        'feature_category', p_feature_category, 'source_refs', p_source_refs, 'source_fingerprints', p_source_fingerprints)));
  perform public.record_ai_help_metric('approved', p_feature_category);
  return jsonb_build_object('status', 'verified', 'topic_id', p_topic_id);
end;
$$;

revoke all on function public.record_ai_help_metric(text, text) from public, anon, authenticated;
revoke all on function public.submit_ai_knowledge_candidate(text, text, text, text, text, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_ai_knowledge(jsonb, text) from public, anon, authenticated;
revoke all on function public.review_ai_knowledge_candidate(uuid, uuid, text, timestamptz, text, text, text, text, text, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.record_ai_help_metric(text, text) to service_role;
grant execute on function public.submit_ai_knowledge_candidate(text, text, text, text, text, jsonb, jsonb, text, text) to service_role;
grant execute on function public.reconcile_ai_knowledge(jsonb, text) to service_role;
grant execute on function public.review_ai_knowledge_candidate(uuid, uuid, text, timestamptz, text, text, text, text, text, jsonb, jsonb, text, text) to service_role;
