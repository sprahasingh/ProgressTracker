begin;
select plan(34);

select has_table('public', 'trackers', 'generic trackers table exists');
select has_table('public', 'tracker_entries', 'generic tracker entries table exists');
select is((select relrowsecurity from pg_class where oid = 'public.trackers'::regclass), true, 'trackers has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.tracker_entries'::regclass), true, 'tracker entries has RLS enabled');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename in ('trackers', 'tracker_entries')), 8::bigint, 'each generic table has four operation-specific policies');
select is((select count(*) from pg_constraint where conname = 'tracker_entries_tracker_owner_fk'), 1::bigint, 'entry foreign key pairs tracker and owner');
select is((select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('trackers', 'tracker_entries') and column_name = 'user_id' and is_nullable = 'NO'), 2::bigint, 'each generic table requires an owner');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000011', 'generic-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000000012', 'generic-owner-two@example.test');

insert into public.trackers (id, user_id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000011', 'habit', 'active', 'Owner one tracker',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000111","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}'),
  ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000012', 'goal', 'active', 'Owner two tracker',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000112","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}');

set local role anon;
select throws_ok($$select * from public.trackers$$, '42501', null, 'anonymous SELECT on trackers is denied');
select throws_ok($$insert into public.trackers (id, kind, status, name, definition) values ('00000000-0000-4000-8000-000000000113', 'habit', 'active', 'anon', '{}')$$, '42501', null, 'anonymous INSERT on trackers is denied');
select throws_ok($$update public.trackers set name = 'anon'$$, '42501', null, 'anonymous UPDATE on trackers is denied');
select throws_ok($$delete from public.trackers$$, '42501', null, 'anonymous DELETE on trackers is denied');
select throws_ok($$select * from public.tracker_entries$$, '42501', null, 'anonymous SELECT on entries is denied');
select throws_ok($$insert into public.tracker_entries (id, tracker_id, entry_date, outcome) values ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000111', '2026-10-09', 'recorded')$$, '42501', null, 'anonymous INSERT on entries is denied');
select throws_ok($$update public.tracker_entries set note = 'anon'$$, '42501', null, 'anonymous UPDATE on entries is denied');
select throws_ok($$delete from public.tracker_entries$$, '42501', null, 'anonymous DELETE on entries is denied');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select results_eq($$select id from public.trackers order by id$$,
  $$values ('00000000-0000-4000-8000-000000000111'::uuid)$$, 'owner one sees only their generic tracker');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000501','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000113","schema_version":1,"kind":"project","status":"active","name":"Owner one new tracker","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000113","kind":"project","status":"active","metrics":[],"schedule":{"kind":"none"}}}')::jsonb)->>'status', 'applied', 'owner can create a tracker through the authenticated sync RPC');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000502','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000114","schema_version":1,"kind":"habit","status":"active","name":"forged","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000114","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"none"}}}')$$,
  '42501', null, 'owner cannot target another account through the RPC');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000503','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000211","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"recorded","entry_values":{"00000000-0000-4000-8000-000000000111":true},"created_at":"2026-10-09T00:00:00Z","updated_at":"2026-10-09T00:00:00Z"}')::jsonb)->>'status', 'applied', 'owner can insert an entry for their tracker through the RPC');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000504','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000212","tracker_id":"00000000-0000-4000-8000-000000000112","entry_date":"2026-10-09","outcome":"recorded"}')$$,
  '23503', null, 'RPC rejects an entry referencing another account tracker');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000505','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000214","tracker_id":"00000000-0000-4000-8000-000000000112","entry_date":"2026-10-09","outcome":"recorded"}')$$,
  '42501', null, 'owner cannot write an entry to another account workspace');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000506','tracker_entry',1,
  '{"id":"00000000-0000-4000-8000-000000000211","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"recorded","note":"updated"}')::jsonb)->>'status', 'applied', 'matching revision permits an entry update through the RPC');
select ok((select server_changed_at > '2000-01-01T00:00:00Z'::timestamptz from public.tracker_entries where id = '00000000-0000-4000-8000-000000000211'),
  'entry server change time cannot be forged');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000507','tracker_entry',1,
  '{"id":"00000000-0000-4000-8000-000000000211","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"recorded","note":"stale"}')::jsonb)->>'status', 'conflict', 'stale entry revision is rejected through the RPC');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
select results_eq($$select id from public.trackers order by id$$,
  $$values ('00000000-0000-4000-8000-000000000112'::uuid)$$, 'owner two sees only their generic tracker');
select results_eq($$select id from public.tracker_entries$$, $$select null::uuid where false$$, 'owner two cannot read owner one entries');
select throws_ok($$update public.trackers set name = 'stolen' where id = '00000000-0000-4000-8000-000000000111'$$, '42501', null, 'direct tracker updates are revoked for authenticated clients');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000508','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000111","schema_version":1,"kind":"habit","status":"active","name":"stolen","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000111","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')::jsonb)->>'status', 'conflict', 'owner two cannot update owner one tracker through the RPC');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000509','tracker_entry',2,
  '{"id":"00000000-0000-4000-8000-000000000211","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"recorded","deleted_at":"2026-10-10T00:00:00Z"}')::jsonb)->>'status', 'applied', 'entry can be tombstoned through the RPC');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000510','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000215","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"skipped"}')$$, '23505', null, 'tombstone reserves tracker/date uniqueness');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000511','tracker_entry',3,
  '{"id":"00000000-0000-4000-8000-000000000211","tracker_id":"00000000-0000-4000-8000-000000000111","entry_date":"2026-10-09","outcome":"recorded","deleted_at":null}')::jsonb)->>'status', 'applied', 'entry can be restored through the RPC');
select results_eq($$select deleted_at is null, server_revision from public.tracker_entries where id = '00000000-0000-4000-8000-000000000211'$$,
  $$values (true, 4::bigint)$$, 'restoration advances the server revision');

reset role;
select lives_ok($$delete from auth.users where id = '00000000-0000-4000-8000-000000000011'$$, 'account deletion cascades generic tracker data');
select results_eq($$select count(*) from public.trackers where user_id = '00000000-0000-4000-8000-000000000011' union all select count(*) from public.tracker_entries where user_id = '00000000-0000-4000-8000-000000000011'$$,
  $$values (0::bigint), (0::bigint)$$, 'account deletion removes owned trackers and entries');

select * from finish();
rollback;
