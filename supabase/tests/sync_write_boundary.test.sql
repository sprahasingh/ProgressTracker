begin;
select plan(17);

select has_table('public', 'sync_operation_receipts', 'private operation receipt table exists');
select is((select relrowsecurity from pg_class where oid = 'public.sync_operation_receipts'::regclass), true, 'receipts table has RLS enabled');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'sync_operation_receipts'), 0::bigint, 'clients have no direct receipt policies');
select is(has_table_privilege('authenticated', 'public.sync_operation_receipts', 'select'), false, 'authenticated clients cannot read receipts directly');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000031', 'sync-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000000032', 'sync-owner-two@example.test');
insert into public.trackers (id, user_id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000331', '00000000-0000-4000-8000-000000000032', 'habit', 'active', 'Owner two row',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000331","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}');

set local role anon;
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000401', 'tracker', null, '{}')$$,
  '42501', null, 'anonymous caller cannot execute the sync function');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000401', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Owner one row","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}'
))->>'status', 'applied'::text, 'owner creates a tracker through the RPC');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000401', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Owner one row","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}'
))->>'status', 'applied'::text, 'identical operation retry replays its receipt');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000301'), 1::bigint, 'retry does not duplicate the tracker');
reset role;
select is((select count(*) from public.sync_operation_receipts where operation_id = '00000000-0000-4000-8000-000000000401'), 1::bigint, 'retry keeps one operation receipt');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';
select throws_ok($$select public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000401', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Changed payload","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')$$,
  '22023', 'operation id was reused with a different payload', 'operation ID cannot be reused for changed content');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000402', 'tracker', 1,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Owner one updated","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}'
))->>'status', 'applied'::text, 'matching revision permits update');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000403', 'tracker', 1,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Stale overwrite","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}'
))->>'status', 'conflict'::text, 'stale revision returns a conflict result');
select is((select name from public.trackers where id = '00000000-0000-4000-8000-000000000301'), 'Owner one updated'::text, 'stale write does not overwrite server data');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000404', 'tracker', null, '{}')$$,
  '42501', 'authenticated owner does not match sync workspace', 'workspace owner must match auth.uid()');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000032';
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000405', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000301","schema_version":1,"kind":"habit","status":"active","name":"Attempted claim","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000301","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}'
))->>'status', 'conflict'::text, 'another account cannot claim a globally used tracker ID');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000301'), 0::bigint, 'conflict response does not expose the other owner row');
select throws_ok($$select public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000406', 'tracker_entry', null,
  '{"id":"00000000-0000-4000-8000-000000000501","tracker_id":"00000000-0000-4000-8000-000000000301","entry_date":"2026-10-09","outcome":"recorded","entry_values":{}}')$$,
  '23503', null, 'entry cannot reference another account tracker through the RPC');

reset role;
select * from finish();
rollback;
