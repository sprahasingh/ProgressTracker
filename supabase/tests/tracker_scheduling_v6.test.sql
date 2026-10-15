begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000031', 'tracker-scheduling-v6@example.test');

select is((select relrowsecurity from pg_class where oid = 'public.trackers'::regclass), true,
  'scheduling schema migration preserves tracker row-level security');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000631', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000131","schema_version":5,"kind":"goal","status":"active","name":"Legacy manual goal","definition":{"schemaVersion":5,"id":"00000000-0000-4000-8000-000000000131","kind":"goal","status":"active","name":"Legacy manual goal","metrics":[],"schedule":{"kind":"weekdays"},"goalPlanning":{"mode":"cumulative-deadline","progressSemantics":{},"dailyTargets":{},"cumulativeTargets":{},"manualAllocations":{"pages":{"2026-10-16":3}}}}}'
)::jsonb)->>'status', 'applied', 'existing schema v5 tracker writes remain compatible');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000632', 'tracker', null,
  '{"id":"00000000-0000-4000-8000-000000000132","schema_version":6,"kind":"challenge","status":"active","name":"Effective challenge","definition":{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000132","kind":"challenge","status":"active","name":"Effective challenge","metrics":[],"schedule":{"kind":"weekdays"},"startDate":"2026-10-15","deadline":"2026-10-19","scheduling":{"mode":"effective","effectiveDays":3,"planningTimeZone":"UTC"}}}'
)::jsonb)->>'status', 'applied', 'schema v6 effective scheduling is accepted through the existing sync RPC');

select results_eq($$select schema_version, definition->'scheduling'->>'mode', definition->'scheduling'->>'effectiveDays'
  from public.trackers where id = '00000000-0000-4000-8000-000000000132'$$,
  $$values (6::smallint, 'effective'::text, '3'::text)$$,
  'schema v6 scheduling settings round-trip in the existing definition JSON');

select results_eq($$select schema_version, definition->'goalPlanning'->'manualAllocations'->'pages'->>'2026-10-16'
  from public.trackers where id = '00000000-0000-4000-8000-000000000131'$$,
  $$values (5::smallint, '3'::text)$$,
  'schema v5 Manual allocation provenance remains intact');

reset role;
select throws_ok($$insert into public.trackers (id, user_id, kind, status, name, schema_version, definition)
  values ('00000000-0000-4000-8000-000000000133', '00000000-0000-4000-8000-000000000031', 'habit', 'active', 'Unsupported schema', 8,
    '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000133","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}')$$,
  '23514', null, 'schema versions beyond v7 remain rejected');

select * from finish();
rollback;
