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

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000421','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000121","schema_version":1,"kind":"goal","status":"active","name":"Legacy goal","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000121","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')::jsonb)->>'status', 'applied',
  'existing version 1 tracker definitions remain insertable through the sync boundary');

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000422','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000122","schema_version":2,"kind":"goal","status":"active","name":"Planned goal","definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000122","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}}}}')::jsonb)->>'status', 'applied',
  'version 2 planned goal is accepted through the authenticated sync boundary');
select results_eq($$select schema_version, server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000122'$$,
  $$values (2::smallint, 1::bigint)$$, 'new version 2 row starts at revision one');

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000423','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000122","schema_version":2,"kind":"goal","status":"active","name":"Planned goal","definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000122","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}},"description":"updated"}}')::jsonb)->>'status', 'applied',
  'version 2 definition updates use the existing revision boundary');
select results_eq($$select server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000122'$$,
  $$values (2::bigint)$$, 'version 2 update advances server revision');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000424','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000122","schema_version":2,"kind":"goal","status":"active","name":"stale","definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000122","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}}}}')::jsonb)->>'status', 'conflict', 'stale version 2 update is rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000425', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000125","schema_version":2,"kind":"goal","status":"active","name":"RPC planned","created_at":"2026-10-09T00:00:00Z","updated_at":"2026-10-09T00:00:00Z","deleted_at":null,"definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000125","kind":"goal","status":"active","name":"RPC planned","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"daily-recurring","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{}}}}'::jsonb
)->>'status'), 'applied', 'the authenticated sync RPC accepts and applies a version 2 goal');
select results_eq($$select schema_version, definition->'goalPlanning'->>'mode', server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000125'$$,
  $$values (2::smallint, 'daily-recurring'::text, 1::bigint)$$, 'the sync RPC stores planning JSON and initializes the existing revision token');

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000426','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000123","schema_version":4,"kind":"project","status":"active","name":"Precise project","definition":{"schemaVersion":4,"id":"00000000-0000-4000-8000-000000000123","kind":"project","status":"active","metrics":[{"id":"hours","name":"Hours","valueType":"duration","precision":{"decimalPlaces":2,"increment":0.25}}],"schedule":{"kind":"weekdays"}}}')::jsonb)->>'status', 'applied',
  'version 4 precision definitions are accepted through the authenticated sync boundary');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000427','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000124","schema_version":2,"kind":"goal","status":"active","name":"Mismatched","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000124","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}}')$$,
  '23514', null, 'definition and row schema versions must still match');

reset role;
select * from finish();
rollback;
