begin;
select plan(15);

select has_table('public', 'support_feedback_send_attempts', 'feedback delivery stores request metadata only');
select is((select relrowsecurity from pg_class where oid='public.support_feedback_send_attempts'::regclass), true, 'feedback idempotency table uses RLS');
select is((select count(*) from pg_policies where schemaname='public' and tablename='support_feedback_send_attempts'), 0::bigint, 'feedback request metadata has no client policies');
select ok(not has_table_privilege('anon','public.support_feedback_send_attempts','select') and not has_table_privilege('authenticated','public.support_feedback_send_attempts','select'), 'browser users cannot inspect feedback request metadata');
select ok(has_function_privilege('service_role','public.begin_support_feedback_submission(uuid,uuid)','execute'), 'server role can reserve rate-limited requests');
select ok(not has_function_privilege('authenticated','public.begin_support_feedback_submission(uuid,uuid)','execute'), 'authenticated browser cannot bypass server feedback submission');
select ok(has_function_privilege('service_role','public.resolve_support_feedback_submission(uuid,uuid,text)','execute') and not has_function_privilege('authenticated','public.resolve_support_feedback_submission(uuid,uuid,text)','execute'), 'only server role can resolve provider delivery outcomes');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000002901','support-feedback@example.test');
set local role service_role;
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002911')->>'allowed', 'true', 'first feedback request is permitted');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002911')->>'processing', 'true', 'duplicate in-flight requests are not sent twice');
select lives_ok($$select public.complete_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002911')$$, 'accepted provider request is recorded');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002911')->>'accepted', 'true', 'same request identifier reports accepted without a second provider send');

select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002912');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002913');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002914');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002915');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002901','00000000-0000-4000-8000-000000002916')->>'allowed', 'false', 'sixth distinct request in fifteen minutes is rate limited');

reset role;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000002902','support-feedback-retry@example.test');
set local role service_role;
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921','rejected');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921','rejected');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921','rejected');
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921','rejected');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921')->>'allowed', 'true', 'request retries count toward the per-user attempt limit');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921','rejected');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002902','00000000-0000-4000-8000-000000002921')->>'allowed', 'false', 'repeating one pending request cannot bypass the rate limit');

reset role;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000002903','support-feedback-uncertain@example.test');
set local role service_role;
select public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002903','00000000-0000-4000-8000-000000002931');
select public.resolve_support_feedback_submission('00000000-0000-4000-8000-000000002903','00000000-0000-4000-8000-000000002931','uncertain');
select is(public.begin_support_feedback_submission('00000000-0000-4000-8000-000000002903','00000000-0000-4000-8000-000000002931')->>'uncertain', 'true', 'uncertain provider outcomes cannot be resent automatically');

reset role;
select * from finish();
rollback;
