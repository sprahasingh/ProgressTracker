begin;
select plan(14);

select has_column('public', 'support_feedback', 'share_email', 'support threads store an explicit email-sharing preference');
select ok((select is_nullable = 'NO' and column_default like '%true%' from information_schema.columns where table_schema='public' and table_name='support_feedback' and column_name='share_email'), 'email sharing has a safe compatibility default');
select ok(has_function_privilege('service_role','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text,boolean)','execute'), 'trusted edge function can submit explicit consent');
select ok(not has_function_privilege('authenticated','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text,boolean)','execute'), 'browser users cannot bypass server-side identity and consent enforcement');
select ok(has_function_privilege('service_role','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text)','execute'), 'older edge function remains compatible during rollout');
select ok(not has_function_privilege('authenticated','public.submit_unified_support_feedback(uuid,uuid,text,text,text,text)','execute'), 'legacy overload remains unavailable to browser users');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000003901','email-consent@example.test');
set local role service_role;
select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911','support_query','ai_help_support','Private email off','Please reply in app.',false);
select is((select share_email from public.support_feedback where request_id='00000000-0000-4000-8000-000000003911'), false, 'unchecked preference is persisted as false');
select is((select count(*) from public.support_feedback_email_outbox where event_key='feedback:' || (select id::text from public.support_feedback where request_id='00000000-0000-4000-8000-000000003911')), 1::bigint, 'email opt-out does not suppress durable in-app feedback and support processing');

select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003912','support_query','settings','Email sharing on','Please contact me.',true);
select is((select share_email from public.support_feedback where request_id='00000000-0000-4000-8000-000000003912'), true, 'checked preference is persisted as true');
select is((select share_identity from public.support_feedback where request_id='00000000-0000-4000-8000-000000003912'), false, 'email contact consent does not grant maintainer identity visibility');
select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003913','general_feedback','settings','Previous client','Legacy request.');
select is((select share_email from public.support_feedback where request_id='00000000-0000-4000-8000-000000003913'), true, 'older six-argument clients retain the compatibility default');
select is((select share_identity from public.support_feedback where request_id='00000000-0000-4000-8000-000000003913'), false, 'legacy email default does not grant maintainer identity visibility');

insert into public.app_settings (id, user_id, share_identity)
values ('general', '00000000-0000-4000-8000-000000003901', true)
on conflict (user_id) do update set share_identity = excluded.share_identity;
select public.submit_unified_support_feedback('00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003914','support_query','settings','Identity only','Please reply in app.',false);
select is((select share_email from public.support_feedback where request_id='00000000-0000-4000-8000-000000003914'), false, 'identity consent does not grant email contact permission');
select is((select share_identity from public.support_feedback where request_id='00000000-0000-4000-8000-000000003914'), true, 'maintainer identity consent is captured independently');

reset role;
select * from finish();
rollback;
