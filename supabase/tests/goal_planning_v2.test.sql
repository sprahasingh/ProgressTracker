begin;
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000021', 'goal-planning-v2@example.test');

select is((select relrowsecurity from pg_class where oid = 'public.trackers'::regclass), true,
  'version support migration preserves tracker RLS');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'trackers'), 4::bigint,
  'version support migration preserves four tracker policies');
select is((select count(*) from pg_trigger where tgrelid = 'public.trackers'::regclass and tgname = 'trackers_server_revision'), 1::bigint,
  'version support migration preserves revision trigger');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000021';

select lives_ok($$insert into public.trackers (id, schema_version, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000121', 1, 'goal', 'active', 'Legacy goal',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000121","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}')$$,
  'existing version 1 tracker definitions remain insertable');

select lives_ok($$insert into public.trackers (id, schema_version, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000122', 2, 'goal', 'active', 'Planned goal',
   '{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000122","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}}}')$$,
  'version 2 planned goal is accepted under the same authenticated owner policy');
select results_eq($$select schema_version, server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000122'$$,
  $$values (2::smallint, 1::bigint)$$, 'new version 2 row starts at revision one');

select lives_ok($$update public.trackers set definition = definition || '{"description":"updated"}', server_revision = 1 where id = '00000000-0000-4000-8000-000000000122'$$,
  'version 2 definition updates use the existing revision boundary');
select results_eq($$select server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000122'$$,
  $$values (2::bigint)$$, 'version 2 update advances server revision');
select throws_ok($$update public.trackers set name = 'stale', server_revision = 1 where id = '00000000-0000-4000-8000-000000000122'$$,
  '40001', null, 'stale version 2 update is rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000425', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000125","schema_version":2,"kind":"goal","status":"active","name":"RPC planned","created_at":"2026-10-09T00:00:00Z","updated_at":"2026-10-09T00:00:00Z","deleted_at":null,"definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000125","kind":"goal","status":"active","name":"RPC planned","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}}}}'::jsonb
)->>'status'), 'applied', 'the authenticated sync RPC accepts and applies a version 2 goal');
select results_eq($$select schema_version, definition->'goalPlanning'->>'mode', server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000125'$$,
  $$values (2::smallint, 'daily-recurring'::text, 1::bigint)$$, 'the sync RPC stores planning JSON and initializes the existing revision token');

select throws_ok($$insert into public.trackers (id, schema_version, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000123', 4, 'goal', 'active', 'Unsupported',
   '{"schemaVersion":4,"id":"00000000-0000-4000-8000-000000000123","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}')$$,
  '23514', null, 'unsupported schema versions remain rejected');
select throws_ok($$insert into public.trackers (id, schema_version, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000124', 2, 'goal', 'active', 'Mismatched',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000124","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}')$$,
  '23514', null, 'definition and row schema versions must still match');

reset role;
select * from finish();
rollback;
