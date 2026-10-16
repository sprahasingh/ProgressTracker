begin;
select plan(7);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000091', 'tracker-schema-v9@example.test');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000191', '00000000-0000-4000-8000-000000000091', 9, 'habit', 'active', 'V9 Typed',
  '{"schemaVersion":9,"id":"00000000-0000-4000-8000-000000000191","kind":"habit","status":"active","name":"V9 Typed","metrics":[{"id":"problems","name":"Problems","valueType":"quantity","unit":"problems"}],"schedule":{"kind":"every-day"},"scheduling":{"mode":"ongoing"},"milestones":[{"id":"total","title":"Total problems","description":"","type":"cumulative-quantity","metricId":"problems","targetValue":50,"measureTypeSnapshot":"quantity","unitSnapshot":"problems","position":0}]}');

select is((select schema_version from public.trackers where id = '00000000-0000-4000-8000-000000000191'), 9::smallint,
  'schema v9 accepts an explicit cumulative quantity milestone');
select is((select definition ? 'streakRuleMode' from public.trackers where id = '00000000-0000-4000-8000-000000000191'), false,
  'schema v9 preserves legacy implicit streak behavior when a tracker is upgraded only for milestones');
select is((select definition->'milestones'->0->>'type' from public.trackers where id = '00000000-0000-4000-8000-000000000191'), 'cumulative-quantity'::text,
  'the server retains the typed milestone definition');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000192', '00000000-0000-4000-8000-000000000091', 9, 'habit', 'active', 'V9 Zero Target',
  '{"schemaVersion":9,"id":"00000000-0000-4000-8000-000000000192","kind":"habit","status":"active","name":"V9 Zero Target","metrics":[{"id":"problems","name":"Problems","valueType":"quantity"}],"schedule":{"kind":"every-day"},"scheduling":{"mode":"ongoing"},"milestones":[{"id":"zero","title":"Zero","description":"","type":"cumulative-quantity","metricId":"problems","targetValue":0,"measureTypeSnapshot":"quantity","unitSnapshot":"problems","position":0}]}')$$,
  '23514', null, 'schema v9 rejects a nonpositive typed milestone target');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000193', '00000000-0000-4000-8000-000000000091', 9, 'habit', 'active', 'V9 Missing Measure',
  '{"schemaVersion":9,"id":"00000000-0000-4000-8000-000000000193","kind":"habit","status":"active","name":"V9 Missing Measure","metrics":[],"schedule":{"kind":"every-day"},"scheduling":{"mode":"ongoing"},"milestones":[{"id":"total","title":"Total","description":"","type":"cumulative-quantity","metricId":"missing","targetValue":50,"measureTypeSnapshot":"quantity","unitSnapshot":"problems","position":0}]}')$$,
  '23514', null, 'schema v9 rejects missing measure references');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000194', '00000000-0000-4000-8000-000000000091', 9, 'habit', 'active', 'V9 Fractional Days',
  '{"schemaVersion":9,"id":"00000000-0000-4000-8000-000000000194","kind":"habit","status":"active","name":"V9 Fractional Days","metrics":[],"schedule":{"kind":"every-day"},"scheduling":{"mode":"ongoing"},"milestones":[{"id":"days","title":"Days","description":"","type":"successful-days","targetValue":2.5,"position":0}]}')$$,
  '23514', null, 'schema v9 requires whole-number date count targets');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000195', '00000000-0000-4000-8000-000000000091', 9, 'challenge', 'active', 'V9 Challenge Too Long',
  jsonb_build_object('schemaVersion',9,'id','00000000-0000-4000-8000-000000000195','kind','challenge','status','active','name','V9 Challenge Too Long','metrics','[]'::jsonb,'schedule','{"kind":"every-day"}'::jsonb,'scheduling','{"mode":"calendar"}'::jsonb,'startDate',current_date::text,'deadline',(current_date+2)::text,'milestones',jsonb_build_array(jsonb_build_object('id','day-4','title','Day four','description','','type','challenge-day','targetValue',4,'position',0))))$$,
  '23514', null, 'schema v9 rejects challenge-day targets beyond the fixed duration');

select * from finish();
rollback;
