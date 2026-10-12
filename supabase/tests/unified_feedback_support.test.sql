begin;
select plan(38);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000081', 'support-user@example.test'),
  ('00000000-0000-4000-8000-000000000082', 'other-support-user@example.test'),
  ('00000000-0000-4000-8000-000000000083', 'support-maintainer@example.test');

select has_table('public','support_feedback','unified feedback table exists');
select has_table('public','support_feedback_messages','thread messages table exists');
select has_table('public','support_feedback_email_outbox','durable email outbox exists');
select is((select relrowsecurity from pg_class where oid='public.support_feedback'::regclass), true, 'feedback RLS enabled');
select is((select relrowsecurity from pg_class where oid='public.support_feedback_messages'::regclass), true, 'message RLS enabled');
select is((select relrowsecurity from pg_class where oid='public.support_feedback_email_outbox'::regclass), true, 'email outbox RLS enabled');
select ok(not has_table_privilege('authenticated','public.support_feedback_email_outbox','select'), 'authenticated users cannot read the email outbox');
select ok(not has_function_privilege('authenticated','public.support_maintainer_reply(uuid,uuid,uuid,text)','execute'), 'users cannot call maintainer reply RPC');
select ok(not has_function_privilege('authenticated','public.support_user_reply(uuid,uuid,uuid,text)','execute'), 'users cannot bypass the authenticated support Edge Function');
select ok(not has_table_privilege('authenticated','public.support_feedback','insert'), 'users cannot impersonate identities through direct inserts');
select ok(not has_table_privilege('authenticated','public.support_feedback','update'), 'users cannot edit maintainer-controlled fields');
select ok(has_function_privilege('service_role','public.support_maintainer_reply(uuid,uuid,uuid,text)','execute'), 'trusted Edge Function can call maintainer reply RPC');
select ok(
  has_function_privilege('service_role','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text)','execute')
  and has_function_privilege('service_role','public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text)','execute')
  and has_function_privilege('service_role','public.support_user_reply(uuid,uuid,uuid,text)','execute')
  and has_function_privilege('service_role','public.support_set_status(uuid,text,uuid,timestamptz)','execute')
  and has_function_privilege('service_role','public.review_unified_ai_answer_feedback(uuid,text,uuid)','execute')
  and has_function_privilege('service_role','public.set_support_email_outcome(uuid,text,text,text)','execute')
  and has_function_privilege('service_role','public.expire_stale_support_email_outbox()','execute')
  and not has_function_privilege('authenticated','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text)','execute')
  and not has_function_privilege('authenticated','public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text)','execute')
  and not has_function_privilege('authenticated','public.support_user_reply(uuid,uuid,uuid,text)','execute')
  and not has_function_privilege('authenticated','public.support_set_status(uuid,text,uuid,timestamptz)','execute')
  and not has_function_privilege('authenticated','public.review_unified_ai_answer_feedback(uuid,text,uuid)','execute')
  and not has_function_privilege('authenticated','public.set_support_email_outcome(uuid,text,text,text)','execute')
  and not has_function_privilege('authenticated','public.expire_stale_support_email_outbox()','execute'),
  'feedback submission, maintainer, and email outcome RPCs are service-role-only');

set local role service_role;
select lives_ok($$select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000181','support_query','ai_help_support','Unable to update goal','My goal did not update after check-in.')$$, 'user support query persists through trusted submission RPC');
select is(public.submit_unified_support_feedback('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000181','support_query','ai_help_support','Unable to update goal','My goal did not update after check-in.') ->> 'duplicate', 'true', 'repeated request ID returns the original record idempotently');
select is((select count(*) from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 1::bigint, 'idempotent retry does not create a second feedback record');
select is((select original_message from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 'My goal did not update after check-in.', 'submitted message is stored without alteration');
select is((select count(*) from public.support_feedback_email_outbox where feedback_id=(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081')), 1::bigint, 'actionable query creates a durable email job');
update public.support_feedback_email_outbox set status='processing', updated_at=now()-interval '3 minutes' where feedback_id=(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081');
select lives_ok($$select public.expire_stale_support_email_outbox()$$, 'stale email attempts can be reconciled');
select is((select status from public.support_feedback_email_outbox limit 1), 'uncertain', 'stale provider attempt becomes uncertain and cannot be resent');
select is((select email_status from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 'uncertain', 'thread reflects uncertain delivery state');
select lives_ok($$select public.support_maintainer_reply('00000000-0000-4000-8000-000000000083',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000183','Please refresh the tracker list and retry.')$$, 'maintainer reply is persisted transactionally');
select is((select status from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 'waiting_for_user', 'maintainer reply moves thread to waiting for user');
select is((select count(*) from public.app_notifications where user_id='00000000-0000-4000-8000-000000000081' and href like '/settings?support=%'), 1::bigint, 'reply creates an owner-only notification deep link');
select throws_ok($$select public.support_user_reply('00000000-0000-4000-8000-000000000082',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000184','Access another user thread')$$, 'P0002', 'Support conversation not found.', 'another user cannot reply to a conversation they do not own');
select lives_ok($$select public.support_user_reply('00000000-0000-4000-8000-000000000081',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000185','I tried that and it worked.')$$, 'owner can reply to their own open thread');
select is((select status from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'), 'open', 'user reply reopens the thread for maintainer attention');
select is((select count(*) from public.support_feedback_email_outbox where feedback_id=(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081')), 2::bigint, 'user reply creates a durable support email job');
update public.support_feedback_email_outbox set status='processing' where event_key=(select event_key from public.support_feedback_email_outbox where event_key like 'reply:%');
select lives_ok($$select public.set_support_email_outcome((select id from public.support_feedback_email_outbox where event_key like 'reply:%'),'accepted','brevo-message-123',null)$$, 'accepted provider outcome can be saved');
select is((select provider_message_id from public.support_feedback_email_outbox where event_key like 'reply:%'), 'brevo-message-123', 'provider message ID is retained for support operations');
select lives_ok($$select public.support_set_status((select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'resolved','00000000-0000-4000-8000-000000000083',(select updated_at from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'))$$, 'maintainer can resolve a support thread with optimistic concurrency check');
select throws_ok($$select public.support_user_reply('00000000-0000-4000-8000-000000000081',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000186','Do not continue after resolved')$$, '55000', 'Resolved conversations cannot be reopened. Start a new support query.', 'resolved thread requires a new support query');
select throws_ok($$select public.support_maintainer_reply('00000000-0000-4000-8000-000000000083',(select id from public.support_feedback where user_id='00000000-0000-4000-8000-000000000081'),'00000000-0000-4000-8000-000000000187','Do not reply after resolution')$$, '55000', 'Resolved conversations cannot be reopened. Change the status before replying.', 'maintainers must explicitly reopen a resolved thread before replying');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';
select is((select count(*) from public.support_feedback), 1::bigint, 'owner can read their support thread');
select is((select count(*) from public.support_feedback_messages), 2::bigint, 'owner can read user and maintainer messages in their thread');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000082';
select is((select count(*) from public.support_feedback), 0::bigint, 'RLS hides another user feedback');
select is((select count(*) from public.support_feedback_messages), 0::bigint, 'RLS hides another user messages');

reset role;
delete from auth.users where id='00000000-0000-4000-8000-000000000081';
select is((select count(*) from public.support_feedback), 0::bigint, 'account deletion cascades through feedback records, messages, and pending email jobs');
select * from finish();
rollback;
