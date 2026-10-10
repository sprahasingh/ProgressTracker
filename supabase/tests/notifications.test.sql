begin;
select plan(28);

select has_table('public','notification_preferences','notification preferences table exists');
select has_table('public','notification_devices','per-device push subscription table exists');
select has_table('public','custom_motivation_messages','custom motivation table exists');
select has_table('public','app_notifications','notification center table exists');
select has_table('public','notification_delivery_attempts','private delivery attempts table exists');
select is((select relrowsecurity from pg_class where oid='public.notification_preferences'::regclass),true,'preferences use RLS');
select is((select relrowsecurity from pg_class where oid='public.notification_devices'::regclass),true,'device subscriptions use RLS');
select is((select relrowsecurity from pg_class where oid='public.custom_motivation_messages'::regclass),true,'custom messages use RLS');
select is((select relrowsecurity from pg_class where oid='public.app_notifications'::regclass),true,'notification center uses RLS');
select is((select relrowsecurity from pg_class where oid='public.notification_delivery_attempts'::regclass),true,'delivery attempts use RLS');
select ok(not has_table_privilege('anon','public.notification_preferences','select'),'anon cannot read preferences');
select ok(not has_table_privilege('anon','public.custom_motivation_messages','select'),'anon cannot read custom messages');
select ok(has_table_privilege('authenticated','public.notification_preferences','select'),'authenticated can read preferences under RLS');
select ok(not has_table_privilege('authenticated','public.notification_delivery_attempts','select'),'delivery attempts remain server-only');

insert into auth.users (id,email) values
 ('00000000-0000-4000-8000-000000001401','notify-one@example.test'),
 ('00000000-0000-4000-8000-000000001402','notify-two@example.test');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001401';
insert into public.notification_preferences(user_id,timezone) values ('00000000-0000-4000-8000-000000001401','Asia/Kolkata');
insert into public.custom_motivation_messages(user_id,message) values ('00000000-0000-4000-8000-000000001401','Small steps count ✨');
insert into public.notification_devices(user_id,endpoint,p256dh,auth_secret) values ('00000000-0000-4000-8000-000000001401','https://push.example.test/endpoint/one','public-key','auth-key');
select is((select count(*) from public.notification_preferences),1::bigint,'account can create its own preferences');
select is((select count(*) from public.custom_motivation_messages),1::bigint,'account can create its own Unicode motivation');
select is((select count(*) from public.notification_devices),1::bigint,'account can register its own device');
reset role;
insert into public.app_notifications(user_id,dedupe_key,category,title,body,href) values
 ('00000000-0000-4000-8000-000000001401','daily-reminder:2026-10-10:16:00','pending','Check-in','A tracker is waiting','/?date=2026-10-10');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001401';
select is((select count(*) from public.app_notifications),1::bigint,'account reads only its own notification');
update public.app_notifications set read_at=now() where dedupe_key='daily-reminder:2026-10-10:16:00';
select ok((select read_at is not null from public.app_notifications where dedupe_key='daily-reminder:2026-10-10:16:00'),'account can update read state');
select throws_ok($$insert into public.app_notifications(user_id,dedupe_key,category,title,body) values ('00000000-0000-4000-8000-000000001401','fake','info','Fake','Not allowed')$$,'42501',null,'clients cannot forge notification records');
select throws_ok($$select * from public.notification_delivery_attempts$$,'42501',null,'clients cannot inspect delivery attempts');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001402';
select is((select count(*) from public.notification_preferences),0::bigint,'another account cannot read preferences');
select is((select count(*) from public.custom_motivation_messages),0::bigint,'another account cannot read custom motivation');
select is((select count(*) from public.app_notifications),0::bigint,'another account cannot read notification history');
reset role;
delete from auth.users where id='00000000-0000-4000-8000-000000001401';
select is((select count(*) from public.notification_preferences where user_id='00000000-0000-4000-8000-000000001401'),0::bigint,'account deletion cascades preferences');
select is((select count(*) from public.custom_motivation_messages where user_id='00000000-0000-4000-8000-000000001401'),0::bigint,'account deletion cascades custom messages');
select is((select count(*) from public.app_notifications where user_id='00000000-0000-4000-8000-000000001401'),0::bigint,'account deletion cascades notification records');
select is((select count(*) from public.notification_devices where user_id='00000000-0000-4000-8000-000000001401'),0::bigint,'account deletion cascades device subscriptions');
select * from finish();
rollback;
