begin;
select plan(12);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000198', 'tracker-v10-strict-mode@example.test');

select lives_ok($$
  insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values (
    '00000000-0000-4000-8000-000000000298',
    '00000000-0000-4000-8000-000000000198', 10, 'habit', 'active', 'Omitted current strict mode',
    jsonb_build_object(
      'schemaVersion', 10, 'id', '00000000-0000-4000-8000-000000000298',
      'kind', 'habit', 'status', 'active', 'name', 'Omitted current strict mode',
      'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
      'streakRuleMode', 'same-as-success',
      'ruleVersions', jsonb_build_array(jsonb_build_object(
        'id', 'omitted-current', 'effectiveFrom', '2026-10-01', 'revision', 1,
        'application', 'baseline', 'recordedAt', '2026-10-01T00:00:00Z',
        'evaluation', jsonb_build_object(
          'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
          'streakRuleMode', 'same-as-success', 'strictMode', false
        )
      ))
    )
  )
$$, 'a fresh v10 insert accepts omitted current strictMode against snapshot false');
select is((select definition ? 'strictMode' from public.trackers where id = '00000000-0000-4000-8000-000000000298'), false,
  'the comparison fix does not write a default into the tracker definition');

select lives_ok($$
  insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values (
    '00000000-0000-4000-8000-000000000299',
    '00000000-0000-4000-8000-000000000198', 10, 'habit', 'active', 'Explicit false strict mode',
    jsonb_build_object(
      'schemaVersion', 10, 'id', '00000000-0000-4000-8000-000000000299',
      'kind', 'habit', 'status', 'active', 'name', 'Explicit false strict mode',
      'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
      'streakRuleMode', 'same-as-success', 'strictMode', false,
      'ruleVersions', jsonb_build_array(jsonb_build_object(
        'id', 'explicit-false', 'effectiveFrom', '2026-10-01', 'revision', 1,
        'application', 'baseline', 'recordedAt', '2026-10-01T00:00:00Z',
        'evaluation', jsonb_build_object(
          'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
          'streakRuleMode', 'same-as-success', 'strictMode', false
        )
      ))
    )
  )
$$, 'explicit current false remains valid');

select lives_ok($$
  insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values (
    '00000000-0000-4000-8000-000000000300',
    '00000000-0000-4000-8000-000000000198', 10, 'habit', 'active', 'Explicit true strict mode',
    jsonb_build_object(
      'schemaVersion', 10, 'id', '00000000-0000-4000-8000-000000000300',
      'kind', 'habit', 'status', 'active', 'name', 'Explicit true strict mode',
      'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
      'streakRuleMode', 'same-as-success', 'strictMode', true,
      'ruleVersions', jsonb_build_array(jsonb_build_object(
        'id', 'explicit-true', 'effectiveFrom', '2026-10-01', 'revision', 1,
        'application', 'baseline', 'recordedAt', '2026-10-01T00:00:00Z',
        'evaluation', jsonb_build_object(
          'schedule', jsonb_build_object('kind', 'every-day'), 'metrics', '[]'::jsonb,
          'streakRuleMode', 'same-as-success', 'strictMode', true
        )
      ))
    )
  )
$$, 'explicit true remains distinct and valid when the snapshot also says true');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values ('00000000-0000-4000-8000-000000000305','00000000-0000-4000-8000-000000000198',10,'habit','active','True versus false',
    jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000305','kind','habit','status','active','name','True versus false',
      'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',true,
      'ruleVersions',jsonb_build_array(jsonb_build_object('id','true-versus-false','effectiveFrom','2026-10-01','revision',1,
        'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
          'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false)))))$$,
  '23514', null, 'explicit true remains different from a snapshot explicitly set to false');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000198',10,'habit','active','Mismatched schedule',
    jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000301','kind','habit','status','active','name','Mismatched schedule',
      'schedule',jsonb_build_object('kind','weekdays'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success',
      'ruleVersions',jsonb_build_array(jsonb_build_object('id','mismatched','effectiveFrom','2026-10-01','revision',1,
        'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
          'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false)))))$$,
  '23514', null, 'a genuine evaluation mismatch is still rejected');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values ('00000000-0000-4000-8000-000000000306','00000000-0000-4000-8000-000000000198',10,'habit','active','Duplicate effective date',
    jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000306','kind','habit','status','active','name','Duplicate effective date',
      'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success',
      'ruleVersions',jsonb_build_array(
        jsonb_build_object('id','duplicate-one','effectiveFrom','2026-10-01','revision',1,'application','baseline','recordedAt','2026-10-01T00:00:00Z',
          'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false)),
        jsonb_build_object('id','duplicate-two','effectiveFrom','2026-10-01','revision',2,'application','apply-from-today','recordedAt','2026-10-02T00:00:00Z',
          'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false)))))$$,
  '23514', null, 'unique effective-date validation remains active');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
  values ('00000000-0000-4000-8000-000000000307','00000000-0000-4000-8000-000000000198',10,'habit','active','Invalid historical rule',
    jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000307','kind','habit','status','active','name','Invalid historical rule',
      'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','custom',
      'streakRule',jsonb_build_object('kind','comparison','metricId','missing','operator','equals','value',1),
      'ruleVersions',jsonb_build_array(jsonb_build_object('id','invalid-rule','effectiveFrom','2026-10-01','revision',1,
        'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
          'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','custom',
          'streakRule',jsonb_build_object('kind','comparison','metricId','missing','operator','equals','value',1),'strictMode',false)))))$$,
  '23514', null, 'historical rule validity checks remain active');

insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values
  ('00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000198',6,'habit','active','Historical v6',
   '{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000302","kind":"habit","status":"active","name":"Historical v6","metrics":[],"schedule":{"kind":"every-day"}}'),
  ('00000000-0000-4000-8000-000000000303','00000000-0000-4000-8000-000000000198',8,'habit','active','Historical v8',
   '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000303","kind":"habit","status":"active","name":"Historical v8","metrics":[],"schedule":{"kind":"every-day"},"streakRuleMode":"same-as-success"}'),
  ('00000000-0000-4000-8000-000000000304','00000000-0000-4000-8000-000000000198',9,'habit','active','Historical v9',
   '{"schemaVersion":9,"id":"00000000-0000-4000-8000-000000000304","kind":"habit","status":"active","name":"Historical v9","metrics":[],"schedule":{"kind":"every-day"}}');

select lives_ok($$update public.trackers set schema_version=10, definition=
  jsonb_build_object('schemaVersion',10,'id',id,'kind','habit','status','active','name',name,
    'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success',
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','upgraded-v6','effectiveFrom','2026-10-01','revision',1,
      'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
        'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false))))
  where id='00000000-0000-4000-8000-000000000302'$$, 'a historical v6 tracker can upgrade to v10 with the client-normalized baseline');
select lives_ok($$update public.trackers set schema_version=10, definition=
  jsonb_build_object('schemaVersion',10,'id',id,'kind','habit','status','active','name',name,
    'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success',
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','upgraded-v8','effectiveFrom','2026-10-01','revision',1,
      'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
        'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false))))
  where id='00000000-0000-4000-8000-000000000303'$$, 'a historical v8 tracker can upgrade to v10 with the client-normalized baseline');
select lives_ok($$update public.trackers set schema_version=10, definition=
  jsonb_build_object('schemaVersion',10,'id',id,'kind','habit','status','active','name',name,
    'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success',
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','upgraded-v9','effectiveFrom','2026-10-01','revision',1,
      'application','baseline','recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object(
        'schedule',jsonb_build_object('kind','every-day'),'metrics','[]'::jsonb,'streakRuleMode','same-as-success','strictMode',false))))
  where id='00000000-0000-4000-8000-000000000304'$$, 'a historical v9 tracker can upgrade to v10 with the client-normalized baseline');

select is((select count(*)::integer from public.trackers where id in (
  '00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000303','00000000-0000-4000-8000-000000000304'
) and schema_version=10 and jsonb_array_length(definition->'ruleVersions')=1), 3,
  'v6, v8, and v9 upgrades retain their new v10 baseline history');

select * from finish();
rollback;
