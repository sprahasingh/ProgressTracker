begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000041', 'tracker-schema-guard@example.test');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000141', '00000000-0000-4000-8000-000000000041', 7, 'habit', 'active', 'V7 Effective',
  '{"schemaVersion":7,"id":"00000000-0000-4000-8000-000000000141","kind":"habit","status":"active","name":"V7 Effective","metrics":[],"schedule":{"kind":"weekdays"},"scheduling":{"mode":"effective","effectiveDays":30,"effectiveDayCounting":"planned-activity-days","planningTimeZone":"UTC"}}');

select throws_ok($$update public.trackers set schema_version = 6,
  definition = jsonb_set(definition, '{schemaVersion}', '6'::jsonb)
  where id = '00000000-0000-4000-8000-000000000141'$$,
  '23514', null, 'an older client cannot downgrade a v7 tracker');

select throws_ok($$update public.trackers set schema_version = 6,
  definition = jsonb_set(definition #- '{scheduling,effectiveDayCounting}', '{schemaVersion}', '6'::jsonb)
  where id = '00000000-0000-4000-8000-000000000141'$$,
  '23514', null, 'a v6 client cannot remove a v7 Effective Days counting preference');

select throws_ok($$update public.trackers set schema_version = 6,
  definition = jsonb_set(jsonb_set(definition, '{schemaVersion}', '6'::jsonb), '{scheduling,effectiveDayCounting}', '"all-non-holiday-days"'::jsonb)
  where id = '00000000-0000-4000-8000-000000000141'$$,
  '23514', null, 'a v6 client cannot change a v7 Effective Days counting preference');

update public.trackers set name = 'V7 Effective edited' where id = '00000000-0000-4000-8000-000000000141';
select is((select name from public.trackers where id = '00000000-0000-4000-8000-000000000141'), 'V7 Effective edited'::text,
  'valid v7 edits remain accepted');

update public.trackers set definition = jsonb_set(definition, '{scheduling,effectiveDayCounting}', '"all-non-holiday-days"'::jsonb)
  where id = '00000000-0000-4000-8000-000000000141';
select is((select definition->'scheduling'->>'effectiveDayCounting' from public.trackers where id = '00000000-0000-4000-8000-000000000141'),
  'all-non-holiday-days'::text, 'a valid v7 counting preference edit remains accepted');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000142', '00000000-0000-4000-8000-000000000041', 6, 'habit', 'active', 'V6 Effective',
  '{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000142","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"weekdays"},"scheduling":{"mode":"effective","effectiveDays":30}}');
select is((select schema_version from public.trackers where id = '00000000-0000-4000-8000-000000000142'), 6::smallint,
  'existing v6 Effective Days records remain compatible');

update public.trackers set name = 'V6 Effective edited' where id = '00000000-0000-4000-8000-000000000142';
select is((select name from public.trackers where id = '00000000-0000-4000-8000-000000000142'), 'V6 Effective edited'::text,
  'valid v6 updates remain accepted without a downgrade');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000143', '00000000-0000-4000-8000-000000000041', 7, 'habit', 'active', 'New V7 Calendar',
  '{"schemaVersion":7,"id":"00000000-0000-4000-8000-000000000143","kind":"habit","status":"active","name":"New V7 Calendar","metrics":[],"schedule":{"kind":"every-day"},"scheduling":{"mode":"calendar"},"deadline":"2026-12-31"}');
select is((select schema_version from public.trackers where id = '00000000-0000-4000-8000-000000000143'), 7::smallint,
  'new v7 tracker creation remains accepted');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000144', '00000000-0000-4000-8000-000000000041', 8, 'habit', 'active', 'V8 Custom Streak',
  '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000144","kind":"habit","status":"active","name":"V8 Custom Streak","metrics":[{"id":"pages","name":"Pages","valueType":"quantity","precision":{"decimalPlaces":0,"increment":1}}],"schedule":{"kind":"every-day"},"streakRuleMode":"custom","streakRule":{"kind":"comparison","metricId":"pages","operator":"at-least","value":1},"qualificationRule":{"kind":"comparison","metricId":"pages","operator":"at-least","value":5}}');
select is((select schema_version from public.trackers where id = '00000000-0000-4000-8000-000000000144'), 8::smallint,
  'a valid custom v8 streak rule is accepted');
select is((select definition->>'streakRuleMode' from public.trackers where id = '00000000-0000-4000-8000-000000000144'), 'custom'::text,
  'the custom streak rule is persisted with its tracker definition');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000145', '00000000-0000-4000-8000-000000000041', 8, 'habit', 'active', 'V8 Missing Rule',
  '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000145","kind":"habit","status":"active","name":"V8 Missing Rule","metrics":[],"schedule":{"kind":"every-day"}}')$$,
  '23514', null, 'v8 rows require an explicit supported streak rule mode');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000146', '00000000-0000-4000-8000-000000000041', 8, 'habit', 'active', 'V8 Incompatible Rule',
  '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000146","kind":"habit","status":"active","name":"V8 Incompatible Rule","metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"},"streakRuleMode":"custom","streakRule":{"kind":"comparison","metricId":"done","operator":"at-least","value":1}}')$$,
  '23514', null, 'v8 rules reject operators incompatible with their measure type');

select throws_ok($$update public.trackers set schema_version = 7, definition = jsonb_set(definition #- '{streakRuleMode}' #- '{streakRule}', '{schemaVersion}', '7'::jsonb)
where id = '00000000-0000-4000-8000-000000000144'$$,
  '23514', null, 'an older client cannot downgrade a v8 tracker or remove its streak rule');
select is((select (not (definition ? 'streakRuleMode') and not (definition ? 'streakRule')) from public.trackers where id = '00000000-0000-4000-8000-000000000143'), true,
  'existing v7 definitions retain their implicit legacy streak behavior');

select * from finish();
rollback;
