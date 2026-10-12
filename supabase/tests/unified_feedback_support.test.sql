begin;
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000081', 'support-user@example.test'),
  ('00000000-0000-4000-8000-000000000082', 'other-support-user@example.test'),
  ('00000000-0000-4000-8000-000000000083', 'support-maintainer@example.test');

select has_table('public','support_feedback','unified feedback table exists');
select has_table('public','support_feedback_messages','thread messages table exists');
select has_table('public','support_feedback_email_outbox','durable email outbox exists');
select is((select relrowsecurity from pg_class where oid='public.support_feedback'::regclass), true, 'feedback RLS enabled');
select is((select relrowsecurity from pg_class where oid='public.support_feedback_messages'::regclass), true, 'message RLS enabled');
select ok(not has_table('public','support_feedback_email_outbox') or not has_table_privilege('authenticated','public.support_feedback_email_outbox','select'), 'authenticated users cannot read the email outbox');
select ok(not has_function_privilege('authenticated','public.support_maintainer_reply(uuid,uuid,uuid,text)','execute'), 'users cannot call maintainer reply RPC');
select ok(has_function_privilege('service_role','public.support_maintainer_reply(uuid,uuid,uuid,text)','execute'), 'trusted Edge Function can call maintainer reply RPC');

set local role service_role;
select lives_ok($$select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000181','support_query','ai_help_support','Unable to update goal','My goal did not update after check-in.')$$, 'user support query persists through trusted submission RPC');
select is((select count(*) from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 1::bigint, 'persisted query is visible to server role');
select is((select count(*) from public.support_feedback_email_outbox where feedback_id=(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081')), 1::bigint, 'actionable query creates a durable email job');
select lives_ok($$select public.support_maintainer_reply('00000000-0000-4000-8000-000000000083',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000183','Please refresh the tracker list and retry.')$$, 'maintainer reply is persisted transactionally');
select is((select status from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 'waiting_for_user', 'maintainer reply moves thread to waiting for user');
select is((select count(*) from public.app_notifications where user_id='00000000-0000-4000-8000-000000000081' and href like '/settings?support=%'), 1::bigint, 'reply creates an owner-only notification deep link');
select throws_ok($$select public.support_user_reply('00000000-0000-4000-8000-000000000082',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000184','Access another user thread')$$, 'P0002', 'Support conversation not found.', 'another user cannot reply to a conversation they do not own');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000082';
select is((select count(*) from public.support_feedback), 0::bigint, 'RLS hides another user feedback');
select is((select count(*) from public.support_feedback_messages), 0::bigint, 'RLS hides another user messages');

reset role;
select * from finish();
rollback;
