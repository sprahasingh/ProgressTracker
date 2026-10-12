begin;
select plan(25);

select has_column('public', 'ai_help_answer_feedback', 'knowledge_decision', 'answer feedback stores a separate knowledge decision');
select has_column('public', 'ai_help_answer_feedback', 'knowledge_candidate_id', 'answer feedback can link a candidate');
select has_table('public', 'ai_help_answer_feedback_review_events', 'feedback review history is retained');
select is((select relrowsecurity from pg_class where oid='public.ai_help_answer_feedback_review_events'::regclass), true, 'review history uses RLS');
select ok(not has_table_privilege('anon', 'public.ai_help_answer_feedback_review_events', 'select') and not has_table_privilege('authenticated', 'public.ai_help_answer_feedback_review_events', 'select'), 'client roles cannot read maintainer review history');
select ok(has_function_privilege('service_role', 'public.review_unified_ai_answer_feedback(uuid,text,uuid)', 'execute'), 'service role can update feedback statuses');
select ok(not has_function_privilege('authenticated', 'public.review_unified_ai_answer_feedback(uuid,text,uuid)', 'execute'), 'authenticated users cannot update feedback statuses directly');
select ok(has_function_privilege('service_role', 'public.set_ai_help_answer_feedback_knowledge_decision(uuid,text,uuid)', 'execute'), 'service role can save knowledge decisions');
select ok(not has_function_privilege('authenticated', 'public.set_ai_help_answer_feedback_knowledge_decision(uuid,text,uuid)', 'execute'), 'authenticated users cannot save maintainer decisions directly');
select ok(has_function_privilege('service_role', 'public.create_ai_help_answer_feedback_candidate(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,text)', 'execute'), 'service role can create linked candidates');
select ok(not has_function_privilege('authenticated', 'public.create_ai_help_answer_feedback_candidate(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,text)', 'execute'), 'authenticated users cannot create maintainer candidates directly');

insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000003501', 'feedback-workflow-user@example.test'),
  ('00000000-0000-4000-8000-000000003502', 'feedback-workflow-maintainer@example.test');
insert into public.ai_help_answer_feedback(user_id, response_id, category, explanation, topic, knowledge_version)
values
  ('00000000-0000-4000-8000-000000003501', '00000000-0000-4000-8000-000000003511', 'outdated', 'The answer instructions have changed.', 'settings', 'bundle-v1'),
  ('00000000-0000-4000-8000-000000003501', '00000000-0000-4000-8000-000000003512', 'outdated', 'The same topic was reported again.', 'settings', 'bundle-v1');

set local role service_role;
select lives_ok($$select public.review_unified_ai_answer_feedback((select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'reviewed', '00000000-0000-4000-8000-000000003502')$$, 'new feedback can be marked reviewed');
select lives_ok($$select public.review_unified_ai_answer_feedback((select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'resolved', '00000000-0000-4000-8000-000000003502')$$, 'reviewed feedback can be resolved');
select lives_ok($$select public.review_unified_ai_answer_feedback((select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'pending', '00000000-0000-4000-8000-000000003502')$$, 'resolved feedback can be reopened as new');
select ok((select not share_identity from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'new feedback remains anonymous by default');
select is((select count(*)::integer from public.ai_help_answer_feedback_review_events where feedback_id=(select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511') and action='status_changed'), 3, 'every status transition is retained in review history');
select is((select reviewed_at from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), null::timestamptz, 'reopened feedback clears current reviewed timestamp');
select is((public.set_ai_help_answer_feedback_knowledge_decision((select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'no_knowledge_change', '00000000-0000-4000-8000-000000003502')->>'knowledge_decision'), 'no_knowledge_change', 'no knowledge change decision persists independently');
select ok((with result as (select public.set_ai_help_answer_feedback_knowledge_decision((select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'no_knowledge_change', '00000000-0000-4000-8000-000000003502') as payload) select not (result.payload ? 'user_id' or result.payload ? 'response_id' or result.payload ? 'explanation') from result), 'decision response omits account, response, and report content');
select is((public.create_ai_help_answer_feedback_candidate(
  (select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'),
  '00000000-0000-4000-8000-000000003502', 'settings.answer_guidance', 'Settings answer guidance',
  'Settings guidance explains the supported preference behavior clearly.', null, 'settings',
  '["src/features/settings/UnifiedSettings.tsx"]'::jsonb,
  '{"src/features/settings/UnifiedSettings.tsx":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
  'bundle-v2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
)->>'created'), 'true', 'maintainer can create a source-backed candidate from feedback');
select is((select count(*)::integer from public.ai_knowledge_candidates where topic_id='settings.answer_guidance' and knowledge_version='bundle-v2'), 1, 'candidate is stored only once');
select ok((select candidate.answer <> feedback.explanation
  from public.ai_knowledge_candidates candidate
  join public.ai_help_answer_feedback feedback on feedback.response_id='00000000-0000-4000-8000-000000003511'
  where candidate.topic_id='settings.answer_guidance' and candidate.knowledge_version='bundle-v2'), 'candidate content comes from maintainer draft, not the user report');
select is((public.create_ai_help_answer_feedback_candidate(
  (select id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003512'),
  '00000000-0000-4000-8000-000000003502', 'settings.answer_guidance', 'Updated settings answer guidance',
  'Settings guidance explains the supported preference behavior clearly.', null, 'settings',
  '["src/features/settings/UnifiedSettings.tsx"]'::jsonb,
  '{"src/features/settings/UnifiedSettings.tsx":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
  'bundle-v2', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
)->>'duplicate'), 'true', 'existing pending topic candidate is linked instead of duplicated');
select is((select knowledge_candidate_id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003512'),
  (select knowledge_candidate_id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'), 'feedback links to the shared existing candidate');
select is((select knowledge_candidate_id from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003511'),
  (select id from public.ai_knowledge_candidates where topic_id='settings.answer_guidance'), 'candidate link is retained after later decision changes');

reset role;
delete from auth.users where id in ('00000000-0000-4000-8000-000000003501', '00000000-0000-4000-8000-000000003502');
select * from finish();
rollback;
