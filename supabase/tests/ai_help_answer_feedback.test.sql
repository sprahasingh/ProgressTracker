begin;
select plan(16);

select has_table('public', 'ai_help_answer_feedback', 'answer feedback reports are stored separately from learned knowledge');
select has_table('public', 'ai_help_feedback_rate_limits', 'feedback submissions have a rate-limit table');
select is((select relrowsecurity from pg_class where oid='public.ai_help_answer_feedback'::regclass), true, 'feedback table uses RLS');
select is((select relrowsecurity from pg_class where oid='public.ai_help_feedback_rate_limits'::regclass), true, 'feedback rate-limit table uses RLS');
select is((select count(*) from pg_policies where schemaname='public' and tablename in ('ai_help_answer_feedback','ai_help_feedback_rate_limits')), 0::bigint, 'feedback has no client policies');
select ok(not has_table_privilege('anon','public.ai_help_answer_feedback','select') and not has_table_privilege('authenticated','public.ai_help_answer_feedback','select'), 'ordinary users cannot read private feedback');
select ok(has_function_privilege('service_role','public.submit_ai_help_answer_feedback(uuid,uuid,text,text,text,text)','execute'), 'trusted server role can submit feedback');
select ok(not has_function_privilege('authenticated','public.submit_ai_help_answer_feedback(uuid,uuid,text,text,text,text)','execute'), 'authenticated clients cannot bypass the server feedback endpoint');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000002801','feedback-owner@example.test'),
  ('00000000-0000-4000-8000-000000002802','feedback-other@example.test');

set local role service_role;
select lives_ok($$select public.record_ai_help_metric('candidate_rejected', 'account')$$, 'candidate validation failures have a distinct aggregate diagnostic event');
select is((public.submit_ai_help_answer_feedback(
  '00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002811',
  'wrong_contact',null,'account','0.1.0+0123456789ab')->>'accepted'), 'true', 'authenticated feedback is accepted without storing an answer transcript');
select is((public.submit_ai_help_answer_feedback(
  '00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002811',
  'other','Could not find the right screen.','account','0.1.0+0123456789ab')->>'duplicate'), 'true', 'one report per user and response is enforced');
select throws_ok($$select public.submit_ai_help_answer_feedback(
  '00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002812',
  'other','Please email me at person@example.test','account','0.1.0+0123456789ab')$$, '22023', 'Invalid answer feedback.', 'email addresses in explanations are rejected');
select throws_ok($$select public.submit_ai_help_answer_feedback(
  '00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002813',
  'other','password: supersecret','account','0.1.0+0123456789ab')$$, '22023', 'Invalid answer feedback.', 'password-like values in explanations are rejected');

select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002821','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002822','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002823','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002824','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002825','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002826','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002827','helpful',null,'account','0.1.0+0123456789ab');
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002828','helpful',null,'account','0.1.0+0123456789ab');
select throws_ok($$select public.submit_ai_help_answer_feedback(
  '00000000-0000-4000-8000-000000002801','00000000-0000-4000-8000-000000002829',
  'helpful',null,'account','0.1.0+0123456789ab')$$, 'P4290', 'AI Help feedback rate limited.', 'eleventh report in a fifteen-minute window is rate limited');

update public.ai_help_answer_feedback set expires_at = now() - interval '1 second'
where user_id = '00000000-0000-4000-8000-000000002801' and response_id = '00000000-0000-4000-8000-000000002811';
select public.submit_ai_help_answer_feedback('00000000-0000-4000-8000-000000002802','00000000-0000-4000-8000-000000002831','helpful',null,'account','0.1.0+0123456789ab');
select is((select count(*) from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000002811'), 0::bigint, 'expired reports are pruned on submission');
select is((select count(*) from public.ai_help_answer_feedback where user_id='00000000-0000-4000-8000-000000002802'), 1::bigint, 'feedback is associated with the verified submitting user');

reset role;
select * from finish();
rollback;
