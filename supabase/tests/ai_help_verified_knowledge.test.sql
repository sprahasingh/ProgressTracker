begin;
select plan(41);

select has_table('public', 'ai_verified_knowledge', 'topic-based verified knowledge exists');
select has_table('public', 'ai_knowledge_review_events', 'maintainer review history exists');
select has_table('public', 'ai_help_learning_metrics', 'aggregate learning metrics exist');
select has_column('public', 'ai_knowledge_candidates', 'topic_id', 'candidates use stable topics');
select has_column('public', 'ai_knowledge_candidates', 'source_fingerprints', 'candidates retain source-specific freshness data');
select ok((select bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('ai_verified_knowledge', 'ai_knowledge_review_events', 'ai_help_learning_metrics')),
  'all learning tables use row-level security');
select ok(not has_table_privilege('anon', 'public.ai_verified_knowledge', 'select'), 'anonymous users cannot read verified knowledge');
select ok(not has_table_privilege('authenticated', 'public.ai_verified_knowledge', 'select'), 'authenticated users cannot read verified knowledge directly');
select ok(not has_table_privilege('authenticated', 'public.ai_knowledge_review_events', 'select'), 'authenticated users cannot read maintainer review history');
select ok(has_function_privilege('service_role', 'public.submit_ai_knowledge_candidate(text,text,text,text,text,jsonb,jsonb,text,text)', 'execute'), 'service role can submit candidates');
select ok(not has_function_privilege('authenticated', 'public.review_ai_knowledge_candidate(uuid,uuid,text,timestamptz,text,text,text,text,text,jsonb,jsonb,text,text)', 'execute'), 'ordinary users cannot approve candidates');
select ok(has_function_privilege('service_role', 'public.reconcile_ai_knowledge(jsonb,text)', 'execute'), 'service role can reconcile source freshness');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000994', 'ai-knowledge-reviewer@example.test');
set local role service_role;

select is((public.submit_ai_knowledge_candidate(
  'measures.type_immutability', 'Saved measure types stay fixed',
  'A saved measure keeps its original type so previous check-ins retain their interpretation.', null, 'trackers',
  '["src/domain/trackers/invariants.ts"]'::jsonb,
  '{"src/domain/trackers/invariants.ts":"fingerprint-before"}'::jsonb,
  'version-1', repeat('a', 64)
)->>'created'), 'true', 'new source-backed topic is queued for review');

select is((public.submit_ai_knowledge_candidate(
  'measures.type_immutability', 'Saved measure types stay fixed',
  'A saved measure keeps its original type so previous check-ins retain their interpretation.', null, 'trackers',
  '["src/domain/trackers/invariants.ts"]'::jsonb,
  '{"src/domain/trackers/invariants.ts":"fingerprint-before"}'::jsonb,
  'version-1', repeat('b', 64)
)->>'duplicate'), 'true', 'same pending topic is deduplicated even with a different candidate fingerprint');

select is((public.submit_ai_knowledge_candidate(
  'measures.retirement', 'Retiring a saved measure',
  'Retirement keeps historical values visible while excluding the measure from future check-ins.', null, 'trackers',
  '["src/domain/trackers/invariants.ts"]'::jsonb,
  '{"src/domain/trackers/invariants.ts":"fingerprint-before"}'::jsonb,
  'version-1', repeat('c', 64)
)->>'created'), 'true', 'a related but distinct topic remains a separate candidate');

select is((select status from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability'), 'pending', 'generated candidates are never automatically trusted');

select is((public.review_ai_knowledge_candidate(
  p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability'),
  p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'approve',
  p_expected_updated_at => (select updated_at from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability'),
  p_topic_id => 'measures.type_immutability', p_title => 'Saved measure types stay fixed',
  p_explanation => 'A saved measure keeps its original type so previous check-ins retain their interpretation.',
  p_feature_category => 'trackers', p_source_refs => '["src/domain/trackers/invariants.ts"]'::jsonb,
  p_source_fingerprints => '{"src/domain/trackers/invariants.ts":"fingerprint-before"}'::jsonb,
  p_knowledge_version => 'version-1', p_candidate_fingerprint => repeat('d', 64)
)->>'status'), 'verified', 'explicit maintainer approval creates trusted knowledge');

select is((select status from public.ai_verified_knowledge where topic_id = 'measures.type_immutability'), 'verified', 'approved topic is eligible for retrieval');
select is((select explanation from public.ai_verified_knowledge where topic_id = 'measures.type_immutability'), 'A saved measure keeps its original type so previous check-ins retain their interpretation.', 'approved explanation is stored independently of question-answer memory');

select is((public.reconcile_ai_knowledge(
  '{"src/domain/trackers/invariants.ts":"fingerprint-before","src/features/goals/GoalsPage.tsx":"unrelated-change"}'::jsonb,
  'version-2'
)->>'verified_stale'), '0', 'an unrelated source change does not stale this topic');
select is((select knowledge_version from public.ai_verified_knowledge where topic_id = 'measures.type_immutability'), 'version-2', 'unaffected verified knowledge advances to the current bundle version');
select is((select status from public.ai_verified_knowledge where topic_id = 'measures.type_immutability'), 'verified', 'unaffected knowledge stays retrievable');

select is((public.reconcile_ai_knowledge(
  '{"src/domain/trackers/invariants.ts":"fingerprint-after","src/features/goals/GoalsPage.tsx":"unrelated-change"}'::jsonb,
  'version-3'
)->>'verified_stale'), '1', 'a changed supporting source marks only affected knowledge stale');
select is((select status from public.ai_verified_knowledge where topic_id = 'measures.type_immutability'), 'stale', 'stale knowledge is excluded from verified retrieval');
select is((select status from public.ai_knowledge_candidates where topic_id = 'measures.retirement'), 'stale', 'pending candidate becomes stale when its evidence changes');

select throws_ok(
  $$select public.review_ai_knowledge_candidate(
    p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.retirement'),
    p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'defer',
    p_expected_updated_at => now() - interval '1 day'
  )$$,
  '40001', 'Candidate changed while it was being reviewed. Refresh and try again.',
  'concurrent or stale review edits are rejected');

select is((public.review_ai_knowledge_candidate(
  p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.retirement'),
  p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'defer',
  p_expected_updated_at => (select updated_at from public.ai_knowledge_candidates where topic_id = 'measures.retirement')
)->>'status'), 'stale', 'defer preserves the candidate status and evidence');
select is((public.review_ai_knowledge_candidate(
  p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.retirement'),
  p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'edit',
  p_expected_updated_at => (select updated_at from public.ai_knowledge_candidates where topic_id = 'measures.retirement'),
  p_topic_id => 'measures.retirement', p_title => 'Retiring a saved measure',
  p_explanation => 'Retirement keeps historical values visible while excluding the measure from future check-ins.',
  p_feature_category => 'trackers', p_source_refs => '["src/domain/trackers/invariants.ts"]'::jsonb,
  p_source_fingerprints => '{"src/domain/trackers/invariants.ts":"fingerprint-after"}'::jsonb,
  p_knowledge_version => 'version-3', p_candidate_fingerprint => repeat('e', 64)
)->>'status'), 'pending', 'maintainer edits requeue stale content under current evidence');
select is((public.review_ai_knowledge_candidate(
  p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.retirement'),
  p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'reject',
  p_expected_updated_at => (select updated_at from public.ai_knowledge_candidates where topic_id = 'measures.retirement')
)->>'status'), 'rejected', 'maintainer rejection keeps the candidate out of verified knowledge');
select is((select status from public.ai_knowledge_candidates where topic_id = 'measures.retirement'), 'rejected', 'rejected candidates remain auditable but are not retrievable');

select is((public.submit_ai_knowledge_candidate(
  'measures.type_immutability', 'Saved measure types stay fixed',
  'A saved measure keeps its original type so previous check-ins retain their interpretation.', null, 'trackers',
  '["src/domain/trackers/invariants.ts"]'::jsonb,
  '{"src/domain/trackers/invariants.ts":"fingerprint-after"}'::jsonb,
  'version-3', repeat('f', 64)
)->>'created'), 'true', 'stale verified concepts can enter a fresh review queue');
select is((select status from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability' and knowledge_version = 'version-3'), 'pending', 'revalidation remains pending until an explicit approval');
select is((public.review_ai_knowledge_candidate(
  p_candidate_id => (select id from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability' and knowledge_version = 'version-3'),
  p_reviewer_id => '00000000-0000-4000-8000-000000000994', p_action => 'approve',
  p_expected_updated_at => (select updated_at from public.ai_knowledge_candidates where topic_id = 'measures.type_immutability' and knowledge_version = 'version-3'),
  p_topic_id => 'measures.type_immutability', p_title => 'Saved measure types stay fixed',
  p_explanation => 'A saved measure keeps its original type so previous check-ins retain their interpretation.',
  p_feature_category => 'trackers', p_source_refs => '["src/domain/trackers/invariants.ts"]'::jsonb,
  p_source_fingerprints => '{"src/domain/trackers/invariants.ts":"fingerprint-after"}'::jsonb,
  p_knowledge_version => 'version-3', p_candidate_fingerprint => repeat('1', 64)
)->>'status'), 'verified', 'revalidated topic becomes current only after maintainer approval');

select is((public.submit_ai_knowledge_candidate(
  'sync.conflict_resolution', 'Offline edit conflicts',
  'When two devices edit a tracker offline, the sync layer preserves and reports conflicting revisions for resolution.', null, 'sync',
  '["src/db/syncConflictRepository.ts"]'::jsonb,
  '{"src/db/syncConflictRepository.ts":"sync-source-current"}'::jsonb,
  'version-1', repeat('2', 64)
)->>'created'), 'true', 'first-version candidate is accepted');
select is((public.submit_ai_knowledge_candidate(
  'sync.conflict_resolution', 'Offline edit conflicts',
  'When two devices edit a tracker offline, the sync layer preserves and reports conflicting revisions for resolution.', null, 'sync',
  '["src/db/syncConflictRepository.ts"]'::jsonb,
  '{"src/db/syncConflictRepository.ts":"sync-source-current"}'::jsonb,
  'version-2', repeat('3', 64)
)->>'created'), 'true', 'same topic across versions can be reconciled without merging unrelated concepts');
select is((public.reconcile_ai_knowledge(
  '{"src/domain/trackers/invariants.ts":"fingerprint-after","src/db/syncConflictRepository.ts":"sync-source-current"}'::jsonb,
  'version-4'
)->>'duplicate_candidates_stale'), '1', 'reconciliation marks older same-topic candidates stale');
select is((select count(*)::integer from public.ai_knowledge_candidates where topic_id = 'sync.conflict_resolution' and status = 'pending'), 1, 'only one current pending topic remains after reconciliation');
select is((select count(*)::integer from public.ai_knowledge_candidates where topic_id = 'sync.conflict_resolution' and status = 'stale'), 1, 'older duplicate candidate is retained for audit');

select is((select count(*)::integer from public.ai_help_learning_metrics where event = 'duplicate_skipped'), 1, 'duplicate skips are retained as an aggregate without question data');
select is((select count(*)::integer from public.ai_knowledge_review_events where topic_id = 'measures.type_immutability' and action = 'approved'), 2, 'approval and revalidation actions are audited');
select ok((select count(*) > 0 from public.ai_help_learning_metrics where event in ('candidate_created', 'duplicate_skipped', 'approved', 'stale_entry')), 'learning metrics aggregate lifecycle events');

select * from finish();
rollback;
