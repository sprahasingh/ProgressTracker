begin;
select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000041', 'tracker-precision-v4@example.test');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000041';

select ok((select convalidated and pg_get_constraintdef(oid) like '%1, 2, 3, 4%'
  from pg_constraint where conrelid = 'public.trackers'::regclass and conname = 'trackers_schema_version_check'),
  'validated tracker constraint preserves versions 1-3 and allows v4');
select is((select relrowsecurity from pg_class where oid = 'public.trackers'::regclass), true,
  'v4 support retains tracker row-level security');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'trackers'), 4::bigint,
  'v4 support leaves existing tracker ownership policies intact');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000441', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000141","schema_version":4,"kind":"goal","status":"active","name":"Precision goal","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null,"definition":{"schemaVersion":4,"id":"00000000-0000-4000-8000-000000000141","kind":"goal","status":"active","name":"Precision goal","metrics":[{"id":"pages","name":"Pages","valueType":"quantity","precision":{"decimalPlaces":2,"increment":0.25}}],"schedule":{"kind":"weekdays"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{"pages":"incremental"},"dailyTargets":{},"cumulativeTargets":{"pages":100},"planningTimeZone":"Asia/Kolkata","allocations":{"pages":{"2026-10-12":1.25}}}}}'::jsonb
)->>'status'), 'applied', 'authenticated sync RPC accepts a v4 precision definition through the existing write boundary');
select results_eq($$select schema_version, server_revision, definition->'metrics'->0->'precision'->>'increment', definition->'goalPlanning'->'allocations'->'pages'->>'2026-10-12' from public.trackers where id = '00000000-0000-4000-8000-000000000141'$$,
  $$values (4::smallint, 1::bigint, '0.25'::text, '1.25'::text)$$,
  'v4 precision and v3 allocation fields persist at revision one');

reset role;
select * from finish();
rollback;
