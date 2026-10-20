begin;
select plan(20);

select has_table('public','tracker_holidays','tracker holiday table exists');
select is((select relrowsecurity from pg_class where oid='public.tracker_holidays'::regclass),true,'tracker holiday table has RLS enabled');
select ok(has_table_privilege('authenticated','public.tracker_holidays','select'),'authenticated can read owner-filtered tracker holidays');
select ok(not has_table_privilege('authenticated','public.tracker_holidays','insert'),'authenticated cannot bypass tracker holiday RPC');
select ok(not has_function_privilege('anon','public.apply_tracker_holiday_sync_operation(uuid,uuid,bigint,jsonb)','execute'),'anonymous users cannot create tracker holidays');
select ok(not has_table_privilege('authenticated','public.private_tracker_holiday_receipts','select'),'tracker holiday receipts remain private');

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000002101','tracker-holiday@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured) values ('general','00000000-0000-4000-8000-000000002101','UTC',true);
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition) values
 ('00000000-0000-4000-8000-000000002111','00000000-0000-4000-8000-000000002101',1,'habit','active','Standard',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000002111","kind":"habit","status":"active","name":"Standard","createdAt":"2026-01-01T00:00:00Z","startDate":"2026-01-01","schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true}}'),
 ('00000000-0000-4000-8000-000000002112','00000000-0000-4000-8000-000000002101',1,'habit','active','Strict',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000002112","kind":"habit","status":"active","name":"Strict","createdAt":"2026-01-01T00:00:00Z","startDate":"2026-01-01","strictMode":true,"schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true}}');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000002101';
select is((public.apply_tracker_holiday_sync_operation(
 '00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002121',null,
 '{"id":"00000000-0000-4000-8000-000000002131","tracker_id":"00000000-0000-4000-8000-000000002111","holiday_date":"2026-10-01","created_at":"2026-09-01T00:00:00Z","updated_at":"2026-09-01T00:00:00Z","deleted_at":null}'
))->>'status','applied','owner creates Standard Mode tracker holiday');
select is((public.apply_tracker_holiday_sync_operation(
 '00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002121',null,
 '{"id":"00000000-0000-4000-8000-000000002131","tracker_id":"00000000-0000-4000-8000-000000002111","holiday_date":"2026-10-01","created_at":"2026-09-01T00:00:00Z","updated_at":"2026-09-01T00:00:00Z","deleted_at":null}'
))->>'status','applied','identical retry replays the receipt');
select is((select count(*) from public.tracker_holidays where user_id='00000000-0000-4000-8000-000000002101'),1::bigint,'idempotent retry does not duplicate the record');
select throws_ok($$select public.apply_tracker_holiday_sync_operation('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002122',null,'{"id":"00000000-0000-4000-8000-000000002132","tracker_id":"00000000-0000-4000-8000-000000002112","holiday_date":"2026-10-01","deleted_at":null}')$$,'22023','Strict Mode trackers cannot have active tracker-specific holidays','Strict Mode tracker-specific holiday is rejected');
select throws_ok($$insert into public.tracker_holidays(id,user_id,tracker_id,holiday_date) values ('00000000-0000-4000-8000-000000002133','00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002111','2026-10-02')$$,'42501',null,'direct authenticated insert is rejected');
select is((public.apply_tracker_holiday_sync_operation(
 '00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002123',1,
 '{"id":"00000000-0000-4000-8000-000000002131","tracker_id":"00000000-0000-4000-8000-000000002111","holiday_date":"2026-10-01","deleted_at":"2026-09-02T00:00:00Z"}'
))->>'status','applied','holiday removal propagates as a soft-delete tombstone');
reset role;
-- The earlier row is now tombstoned; re-add the holiday to test server progression semantics.
select is((public.apply_tracker_holiday_sync_operation(
 '00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002124',2,
 '{"id":"00000000-0000-4000-8000-000000002131","tracker_id":"00000000-0000-4000-8000-000000002111","holiday_date":"2026-10-01","deleted_at":null}'
))->>'status','applied','holiday restoration clears the tombstone');
select ok((select not public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002111'),'tracker holiday excuses a Standard Mode tracker without work');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000002141','00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002111','2026-10-01','recorded','{"done":false}');
select ok((select not public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002111'),'zero work does not override a tracker holiday');
update public.tracker_entries set entry_values='{"done":true}' where id='00000000-0000-4000-8000-000000002141';
select ok((select public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002111'),'positive qualifying work restores Standard Mode progression eligibility');
update public.tracker_entries set outcome='skipped' where id='00000000-0000-4000-8000-000000002141';
select ok((select not public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002111'),'skipping does not override a tracker holiday');
insert into public.account_holidays(id,user_id,holiday_date,reason) values ('00000000-0000-4000-8000-000000002151','00000000-0000-4000-8000-000000002101','2026-10-01','personal');
select ok((select public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002112'),'global holidays do not excuse Strict Mode progression');
update public.trackers set definition=definition || '{"strictMode":true}' where id='00000000-0000-4000-8000-000000002111';
select ok((select public.progression_date_is_eligible('00000000-0000-4000-8000-000000002101',t,'2026-10-01') from public.trackers t where t.id='00000000-0000-4000-8000-000000002111'),'an existing tracker-specific holiday does not exempt a tracker after it changes to Strict Mode');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000002101';
select is((public.apply_tracker_holiday_sync_operation(
 '00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000002125',3,
 '{"id":"00000000-0000-4000-8000-000000002131","tracker_id":"00000000-0000-4000-8000-000000002111","holiday_date":"2026-10-01","deleted_at":"2026-09-03T00:00:00Z"}'
))->>'status','applied','existing holiday tombstones can be removed after its tracker changes to Strict Mode');
reset role;
select * from finish();
rollback;
