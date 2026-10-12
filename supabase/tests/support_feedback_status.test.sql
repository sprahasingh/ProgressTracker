begin;
select plan(8);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000003201','status-thread@example.test');
insert into public.support_feedback(id,user_id,category,source,subject,original_message)
values ('00000000-0000-4000-8000-000000003211','00000000-0000-4000-8000-000000003201','support_query','settings','Status test','Check status transitions.');

set local role service_role;
select is((public.support_set_status('00000000-0000-4000-8000-000000003211','in_progress','00000000-0000-4000-8000-000000003202',(select updated_at from public.support_feedback where id='00000000-0000-4000-8000-000000003211'))->>'status'),'in_progress','maintainer can move open thread to in progress');
select is((public.support_set_status('00000000-0000-4000-8000-000000003211','waiting_for_user','00000000-0000-4000-8000-000000003202',(select updated_at from public.support_feedback where id='00000000-0000-4000-8000-000000003211'))->>'status'),'waiting_for_user','maintainer can move thread to waiting for user');
select is((public.support_set_status('00000000-0000-4000-8000-000000003211','resolved','00000000-0000-4000-8000-000000003202',(select updated_at from public.support_feedback where id='00000000-0000-4000-8000-000000003211'))->>'status'),'resolved','maintainer can resolve thread');
select is((public.support_set_status('00000000-0000-4000-8000-000000003211','open','00000000-0000-4000-8000-000000003202',(select updated_at from public.support_feedback where id='00000000-0000-4000-8000-000000003211'))->>'status'),'open','maintainer can explicitly reopen resolved thread');
select throws_ok($$select public.support_set_status('00000000-0000-4000-8000-000000003211','archived','00000000-0000-4000-8000-000000003202',(select updated_at from public.support_feedback where id='00000000-0000-4000-8000-000000003211'))$$,'22023','Invalid support status.','unsupported status is rejected');
select throws_ok($$select public.support_set_status('00000000-0000-4000-8000-000000003211','resolved','00000000-0000-4000-8000-000000003202',now()-interval '1 day')$$,'40001','Support conversation changed. Refresh and retry.','stale concurrent update is rejected');
select ok(not has_function_privilege('authenticated','public.support_set_status(uuid,text,uuid,timestamptz)','execute'),'ordinary users cannot mutate support thread status');
select is((select status from public.support_feedback where id='00000000-0000-4000-8000-000000003211'),'open','rejected changes leave the saved status intact');

reset role;
delete from auth.users where id='00000000-0000-4000-8000-000000003201';
select * from finish();
rollback;
