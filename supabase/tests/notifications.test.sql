begin;
select plan(45);

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
select ok(not has_table_privilege('anon','public.notification_devices','select'),'anon cannot read push subscriptions');
select ok(not has_table_privilege('anon','public.notification_devices','insert'),'anon cannot register push subscriptions');
select ok(not has_table_privilege('authenticated','public.notification_devices','select'),'authenticated cannot read endpoints or key material');
select ok(not has_table_privilege('authenticated','public.notification_devices','insert'),'authenticated cannot register subscriptions directly');
select ok(not has_table_privilege('authenticated','public.notification_devices','update'),'authenticated cannot rotate or revoke subscriptions directly');
select ok(not has_table_privilege('authenticated','public.notification_devices','delete'),'authenticated cannot delete subscription rows directly');
select ok(has_table_privilege('service_role','public.notification_devices','select'),'trusted server role can manage subscriptions');
select ok(has_table_privilege('service_role','public.notification_devices','insert'),'trusted server role can register subscriptions');
select is((select count(*) from pg_policies where schemaname='public' and tablename='notification_devices'),0::bigint,'subscription table has no client-facing RLS policy');

insert into auth.users (id,email) values
 ('00000000-0000-4000-8000-000000001401','notify-one@example.test'),
 ('00000000-0000-4000-8000-000000001402','notify-two@example.test');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001401';
insert into public.notification_preferences(user_id,timezone) values ('00000000-0000-4000-8000-000000001401','Asia/Kolkata');
select throws_ok($$insert into public.notification_preferences(user_id,timezone) values ('00000000-0000-4000-8000-000000001402','UTC')$$,'42501',null,'authenticated clients cannot create preferences for another account');
insert into public.custom_motivation_messages(user_id,message) values ('00000000-0000-4000-8000-000000001401','Small steps count ✨');
select throws_ok($$insert into public.notification_devices(user_id,endpoint,p256dh,auth_secret) values ('00000000-0000-4000-8000-000000001401','https://push.example.test/endpoint/client','client-key','client-secret')$$,'42501',null,'authenticated clients cannot create subscriptions');
select is((select count(*) from public.notification_preferences),1::bigint,'account can create its own preferences');
select is((select count(*) from public.custom_motivation_messages),1::bigint,'account can create its own Unicode motivation');
reset role;

set local role service_role;
insert into public.notification_devices(user_id,endpoint,p256dh,auth_secret) values
 ('00000000-0000-4000-8000-000000001401','https://push.example.test/endpoint/one','public-key-one','auth-key-one'),
 ('00000000-0000-4000-8000-000000001401','https://push.example.test/endpoint/two','public-key-two','auth-key-two'),
 ('00000000-0000-4000-8000-000000001402','https://push.example.test/endpoint/other','public-key-other','auth-key-other');
select is((select count(*) from public.notification_devices where user_id='00000000-0000-4000-8000-000000001401'),2::bigint,'trusted subscription manager can keep multiple devices per account');
select throws_ok($$insert into public.notification_devices(user_id,endpoint,p256dh,auth_secret) values ('00000000-0000-4000-8000-000000001402','https://push.example.test/endpoint/one','other-key','other-secret')$$,'23505',null,'one browser subscription endpoint cannot be attached to two accounts');
update public.notification_devices set expires_at=now()+interval '30 days' where endpoint='https://push.example.test/endpoint/two';
select ok((select expires_at > now() from public.notification_devices where endpoint='https://push.example.test/endpoint/two'),'subscription expiry can be recorded');
update public.notification_devices set enabled=false, revoked_at=now() where endpoint='https://push.example.test/endpoint/one';
select ok((select not enabled and revoked_at is not null from public.notification_devices where endpoint='https://push.example.test/endpoint/one'),'revocation disables a device and records its revocation time');
insert into public.notification_delivery_attempts(user_id,device_id,dedupe_key,scheduled_for,status,next_attempt_at)
select user_id,id,'reminder:2026-10-10:16:00',now(),'queued',now() from public.notification_devices where endpoint='https://push.example.test/endpoint/two';
select is((select count(*) from public.notification_delivery_attempts where user_id='00000000-0000-4000-8000-000000001401'),1::bigint,'delivery attempt is associated with an owned device');
select throws_ok($$insert into public.notification_delivery_attempts(user_id,device_id,dedupe_key,scheduled_for,status,next_attempt_at) select '00000000-0000-4000-8000-000000001401',id,'cross-account',now(),'queued',now() from public.notification_devices where user_id='00000000-0000-4000-8000-000000001402'$$,'23503',null,'attempt cannot associate one account with another account device');
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
select is((select count(*) from public.notification_delivery_attempts where user_id='00000000-0000-4000-8000-000000001401'),0::bigint,'account deletion cascades delivery attempts');
select * from finish();
rollback;
