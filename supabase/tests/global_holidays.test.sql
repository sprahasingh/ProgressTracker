begin;
select plan(21);

select has_table('public','account_holidays','account holiday table exists');
select is((select relrowsecurity from pg_class where oid='public.account_holidays'::regclass),true,'holiday table has RLS enabled');
select ok(has_table_privilege('authenticated','public.account_holidays','select'),'authenticated can read through owner-filtered RLS');
select ok(not has_table_privilege('authenticated','public.account_holidays','insert'),'authenticated cannot bypass the holiday write RPC');
select ok(not has_table_privilege('authenticated','public.account_holidays','update'),'authenticated cannot bypass revision checks');
select ok(not has_table_privilege('authenticated','public.account_holidays','delete'),'authenticated cannot bypass synchronized tombstones');
select ok(not has_function_privilege('anon','public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb)','execute'),'anon cannot execute the write RPC');
select ok(not has_table_privilege('authenticated','public.private_account_holiday_receipts','select'),'operation receipts remain private');

insert into auth.users (id,email) values
 ('00000000-0000-4000-8000-000000001101','holiday-one@example.test'),
 ('00000000-0000-4000-8000-000000001102','holiday-two@example.test');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001101';
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001201',null,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}'
))->>'status','applied'::text,'owner creates holiday through the secure RPC');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001201',null,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}'
))->>'status','applied'::text,'retry replays an identical receipt');
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000001301'),1::bigint,'retry does not duplicate holiday row');
select throws_ok($$insert into public.account_holidays(id,holiday_date) values ('00000000-0000-4000-8000-000000001302','2026-12-25')$$,'42501',null,'direct authenticated INSERT is rejected');
select throws_ok($$select * from public.private_account_holiday_receipts$$,'42501',null,'authenticated cannot read idempotency receipts');
reset role;

insert into public.account_holidays(id,user_id,holiday_date,reason) values
 ('00000000-0000-4000-8000-000000001303','00000000-0000-4000-8000-000000001102','2026-12-24','exam');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001102';
select is((select count(*) from public.account_holidays),1::bigint,'second user sees only their own holiday');
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000001301'),0::bigint,'second user cannot read first user holiday');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001102','00000000-0000-4000-8000-000000001202',null,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-26","reason":"other","deleted_at":null}'
))->>'status','conflict'::text,'foreign identifier cannot be claimed');
select throws_ok($$select public.apply_account_holiday_sync_operation('00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001203',null,'{}')$$,'42501','authenticated owner does not match holiday workspace','RPC enforces auth.uid ownership');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000001101';
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001204',0,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-24","reason":"personal","deleted_at":null}'
))->>'status','conflict'::text,'stale revision is returned as conflict');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001205',1,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-24","reason":"travel","deleted_at":"2026-10-10T01:00:00Z"}'
))->>'status','applied'::text,'holiday removal propagates as a revisioned tombstone');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000001206',2,
 '{"id":"00000000-0000-4000-8000-000000001301","holiday_date":"2026-12-24","reason":"travel","deleted_at":null}'
))->>'status','applied'::text,'holiday restoration is a revisioned update');
select is((select deleted_at from public.account_holidays where id='00000000-0000-4000-8000-000000001301'),null::timestamptz,'restored holiday is live again');

select * from finish();
rollback;
