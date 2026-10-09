begin;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000031', 'goal-planning-v3@example.test');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';

select ok((select pg_get_constraintdef(oid) like '%1, 2, 3%'
  from pg_constraint where conrelid = 'public.trackers'::regclass and conname = 'trackers_schema_version_check'),
  'schema version constraint retains v1 and v2 and adds v3');
select is((select relrowsecurity from pg_class where oid = 'public.trackers'::regclass), true,
  'v3 support retains tracker RLS');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'trackers'), 4::bigint,
  'v3 support does not change tracker ownership policies');

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000432','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000131","schema_version":3,"kind":"goal","status":"active","name":"Allocated goal","definition":{"schemaVersion":3,"id":"00000000-0000-4000-8000-000000000131","kind":"goal","status":"active","name":"Allocated goal","metrics":[],"schedule":{"kind":"weekdays"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{"pages":"incremental"},"dailyTargets":{"pages":2},"cumulativeTargets":{"pages":20},"planningTimeZone":"Asia/Kolkata","allocations":{"pages":{"2026-10-09":4}}}}}')::jsonb)->>'status', 'applied',
  'version 3 allocation definition persists through the supported write boundary');
select results_eq($$select schema_version, server_revision, definition->'goalPlanning'->>'planningTimeZone', definition->'goalPlanning'->'allocations'->'pages'->>'2026-10-09' from public.trackers where id = '00000000-0000-4000-8000-000000000131'$$,
  $$values (3::smallint, 1::bigint, 'Asia/Kolkata'::text, '4'::text)$$,
  'v3 timezone and allocation persist with initial revision one');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000433','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000131","schema_version":3,"kind":"goal","status":"active","name":"Allocated goal","definition":{"schemaVersion":3,"id":"00000000-0000-4000-8000-000000000131","kind":"goal","status":"active","name":"Allocated goal","metrics":[],"schedule":{"kind":"weekdays"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{"pages":"incremental"},"dailyTargets":{"pages":2},"cumulativeTargets":{"pages":20},"planningTimeZone":"Asia/Kolkata","allocations":{"pages":{"2026-10-09":5}}}}}')::jsonb)->>'status', 'applied',
  'allocation update uses the existing revision-protected sync RPC');
select is((select server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000131'), 2::bigint,
  'v3 allocation update advances server revision');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000434','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000131","schema_version":3,"kind":"goal","status":"active","name":"stale","definition":{"schemaVersion":3,"id":"00000000-0000-4000-8000-000000000131","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"weekdays"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{"pages":"incremental"},"dailyTargets":{"pages":2},"cumulativeTargets":{"pages":20},"planningTimeZone":"Asia/Kolkata","allocations":{"pages":{"2026-10-09":5}}}}}')::jsonb)->>'status', 'conflict', 'stale v3 update remains rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000431', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000141","schema_version":3,"kind":"goal","status":"active","name":"RPC allocated","created_at":"2026-10-09T00:00:00Z","updated_at":"2026-10-09T00:00:00Z","deleted_at":null,"definition":{"schemaVersion":3,"id":"00000000-0000-4000-8000-000000000141","kind":"goal","status":"active","name":"RPC allocated","metrics":[],"schedule":{"kind":"every-day"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{"pages":"incremental"},"dailyTargets":{},"cumulativeTargets":{"pages":20},"planningTimeZone":"UTC","allocations":{"pages":{"2026-10-09":20}}}}}'::jsonb
)->>'status'), 'applied', 'authenticated sync RPC accepts v3 tracker allocations');
select results_eq($$select schema_version, server_revision from public.trackers where id = '00000000-0000-4000-8000-000000000141'$$,
  $$values (3::smallint, 1::bigint)$$, 'RPC v3 insert initializes the existing revision token');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000435','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000132","schema_version":4,"kind":"goal","status":"active","name":"Unsupported","definition":{"schemaVersion":4,"id":"00000000-0000-4000-8000-000000000132","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}}')$$,
  '23514', null, 'unsupported schema version 4 remains rejected');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000436','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000133","schema_version":3,"kind":"goal","status":"active","name":"Mismatched","definition":{"schemaVersion":2,"id":"00000000-0000-4000-8000-000000000133","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"none"}}}')$$,
  '23514', null, 'definition and row schema versions must still match');

reset role;
select * from finish();
rollback;
