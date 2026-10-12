begin;
select plan(7);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000003101','answer-routing@example.test');
set local role service_role;

select is((public.submit_unified_ai_answer_feedback(
  '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003111','helpful',null,'account','test-bundle'
)->>'accepted'), 'true', 'helpful rating submission succeeds');
select is((select status from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003111'), 'resolved', 'helpful rating is automatically resolved');
select is((select count(*)::integer from public.support_feedback where metadata->>'response_id'='00000000-0000-4000-8000-000000003111'), 0, 'helpful rating does not create a synthetic support case');

select is((public.submit_unified_ai_answer_feedback(
  '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003112','wrong_instructions','The steps did not match.','account','test-bundle'
)->>'accepted'), 'true', 'negative rating submission succeeds');
select is((select status from public.ai_help_answer_feedback where response_id='00000000-0000-4000-8000-000000003112'), 'pending', 'negative rating remains available for maintainer review');
select is((select count(*)::integer from public.support_feedback where metadata->>'response_id'='00000000-0000-4000-8000-000000003112'), 0, 'negative rating does not create a duplicate support case');
select ok(not has_function_privilege('authenticated','public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text)','execute'), 'ordinary users cannot bypass the feedback Edge Function');

reset role;
delete from auth.users where id='00000000-0000-4000-8000-000000003101';
select * from finish();
rollback;
