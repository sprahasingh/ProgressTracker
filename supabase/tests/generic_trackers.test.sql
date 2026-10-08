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
select lives_ok($$insert into public.trackers (id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000113', 'project', 'active', 'Owner one new tracker',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000113","kind":"project","status":"active","metrics":[],"schedule":{"kind":"none"}}')$$,
  'owner one can create a tracker with auth.uid() owner default');
select throws_ok($$insert into public.trackers (id, user_id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000012', 'habit', 'active', 'forged',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000114","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"none"}}')$$,
  '42501', null, 'owner cannot assign a tracker to another account');
select lives_ok($$insert into public.tracker_entries (id, tracker_id, entry_date, outcome, entry_values, server_changed_at) values
  ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000111', '2026-10-09', 'recorded', '{"00000000-0000-4000-8000-000000000111":true}', '2000-01-01T00:00:00Z')$$,
  'owner can insert an entry for their tracker');
select throws_ok($$insert into public.tracker_entries (id, tracker_id, entry_date, outcome) values
  ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000112', '2026-10-09', 'recorded')$$,
  '23503', null, 'entry cannot reference another user tracker through the composite foreign key');
select throws_ok($$insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome) values
  ('00000000-0000-4000-8000-000000000214', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000112', '2026-10-09', 'recorded')$$,
  '42501', null, 'owner cannot assign an entry to another account');
select lives_ok($$update public.tracker_entries set note = 'updated', server_revision = 1 where id = '00000000-0000-4000-8000-000000000211'$$,
  'matching revision permits an entry update');
select ok((select server_changed_at > '2000-01-01T00:00:00Z'::timestamptz from public.tracker_entries where id = '00000000-0000-4000-8000-000000000211'),
  'entry server change time cannot be forged');
select throws_ok($$update public.tracker_entries set note = 'stale', server_revision = 1 where id = '00000000-0000-4000-8000-000000000211'$$,
  '40001', null, 'stale entry revision is rejected');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
select results_eq($$select id from public.trackers order by id$$,
  $$values ('00000000-0000-4000-8000-000000000112'::uuid)$$, 'owner two sees only their generic tracker');
select results_eq($$select id from public.tracker_entries$$, $$select null::uuid where false$$, 'owner two cannot read owner one entries');
select results_eq($$update public.trackers set name = 'stolen' where id = '00000000-0000-4000-8000-000000000111' returning id$$,
  $$select null::uuid where false$$, 'owner two cannot update owner one tracker');
select results_eq($$delete from public.trackers where id = '00000000-0000-4000-8000-000000000111' returning id$$,
  $$select null::uuid where false$$, 'owner two cannot delete owner one tracker');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
select lives_ok($$update public.tracker_entries set deleted_at = now(), server_revision = 2 where id = '00000000-0000-4000-8000-000000000211'$$,
  'entry can be tombstoned');
select throws_ok($$insert into public.tracker_entries (id, tracker_id, entry_date, outcome) values
  ('00000000-0000-4000-8000-000000000215', '00000000-0000-4000-8000-000000000111', '2026-10-09', 'skipped')$$,
  '23505', null, 'tombstone reserves tracker/date uniqueness');
select lives_ok($$update public.tracker_entries set deleted_at = null, server_revision = 3 where id = '00000000-0000-4000-8000-000000000211'$$,
  'entry can be restored using its original UUID');
select results_eq($$select deleted_at is null, server_revision from public.tracker_entries where id = '00000000-0000-4000-8000-000000000211'$$,
  $$values (true, 4::bigint)$$, 'restoration advances the server revision');

reset role;
select lives_ok($$delete from auth.users where id = '00000000-0000-4000-8000-000000000011'$$, 'account deletion cascades generic tracker data');
select results_eq($$select count(*) from public.trackers where user_id = '00000000-0000-4000-8000-000000000011' union all select count(*) from public.tracker_entries where user_id = '00000000-0000-4000-8000-000000000011'$$,
  $$values (0::bigint), (0::bigint)$$, 'account deletion removes owned trackers and entries');

select * from finish();
rollback;
