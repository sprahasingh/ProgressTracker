-- Synthetic regression fixtures based only on the supplied version/revision
-- summaries. These are not the original MERN or CP device operations.
begin;
select plan(10);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000208', 'synthetic-tracker-upgrades@example.test');

-- MERN-like cloud state: v6 at revision 1. The v8 and v10 writes below use
-- the real RPC and expected revision. The v10 head omits strictMode while its
-- snapshot records the client-normalized false value.
insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values
  ('00000000-0000-4000-8000-000000000408','00000000-0000-4000-8000-000000000208',6,'habit','active','Synthetic MERN v6',
   '{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000408","kind":"habit","status":"active","name":"Synthetic MERN v6","metrics":[],"schedule":{"kind":"every-day"}}'),
  ('00000000-0000-4000-8000-000000000409','00000000-0000-4000-8000-000000000208',6,'habit','active','Synthetic MERN v6 for v10',
   '{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000409","kind":"habit","status":"active","name":"Synthetic MERN v6 for v10","metrics":[],"schedule":{"kind":"every-day"}}');

select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000408'),1::bigint,
  'synthetic MERN cloud fixture starts at revision 1');
select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000409'),1::bigint,
  'synthetic v10 upgrade fixture starts at revision 1');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000208';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000208','00000000-0000-4000-8000-000000000508','tracker',1,
  jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000408','schema_version',8,'kind','habit','status','active','name','Synthetic MERN v8',
    'definition',jsonb_build_object('schemaVersion',8,'id','00000000-0000-4000-8000-000000000408','kind','habit','status','active','name','Synthetic MERN v8',
      'schedule',jsonb_build_object('kind','every-day'),
      'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean','required',false,'position',0)),
      'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
      'streakRuleMode','custom','streakRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))
  )
))->>'status','applied','synthetic v6-to-v8 tracker update succeeds through the authenticated RPC');
select is((select schema_version::integer * 100 + server_revision::integer from public.trackers where id='00000000-0000-4000-8000-000000000408'),802,
  'synthetic v6-to-v8 update stores schema v8 and advances the cloud revision');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000208','00000000-0000-4000-8000-000000000509','tracker',1,
  jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000409','schema_version',10,'kind','habit','status','active','name','Synthetic MERN v10',
    'definition',jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000409','kind','habit','status','active','name','Synthetic MERN v10',
      'schedule',jsonb_build_object('kind','every-day'),
      'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean','required',false,'position',0)),
      'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
      'streakRuleMode','custom','streakRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
      'ruleVersions',jsonb_build_array(jsonb_build_object(
        'id','synthetic-v10-baseline','effectiveFrom','2026-10-01','revision',1,'application','baseline','recordedAt','2026-10-01T00:00:00Z',
        'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),
          'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean','required',false,'position',0)),
          'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
          'streakRuleMode','custom','streakRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
          'strictMode',false)
      ))
    )
  )
))->>'status','applied','synthetic v6-to-v10 update accepts omitted current strictMode against snapshot false');
select is((select schema_version::integer * 100 + server_revision::integer from public.trackers where id='00000000-0000-4000-8000-000000000409'),1002,
  'synthetic v6-to-v10 update stores schema v10 and advances the cloud revision');

reset role;

-- CP-like cloud state: v8/revision 3 with the same synthetic custom-rule
-- structure. Two local fixture updates advance the initial revision to 3.
insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000410','00000000-0000-4000-8000-000000000208',8,'habit','active','Synthetic CP v8',
  '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000410","kind":"habit","status":"active","name":"Synthetic CP v8","schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean","required":false,"position":0}],"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true},"streakRuleMode":"custom","streakRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true}}');
update public.trackers set name='Synthetic CP v8 revision 2' where id='00000000-0000-4000-8000-000000000410';
update public.trackers set name='Synthetic CP v8 revision 3' where id='00000000-0000-4000-8000-000000000410';
select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000410'),3::bigint,
  'synthetic CP cloud fixture reaches revision 3');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000208','00000000-0000-4000-8000-000000000510','tracker',3,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000410','schema_version',8,'kind','habit','status','active','name','Synthetic CP local edit',
    'definition','{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000410","kind":"habit","status":"active","name":"Synthetic CP local edit","schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean","required":false,"position":0}],"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true},"streakRuleMode":"custom","streakRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true}}'::jsonb)
))->>'status','applied','synthetic v8-to-v8 update succeeds when its expected revision and custom rule are valid');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000208','00000000-0000-4000-8000-000000000511','tracker',3,
  '{"id":"00000000-0000-4000-8000-000000000410","schema_version":8,"kind":"habit","status":"active","name":"Synthetic stale CP write","definition":{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000410","kind":"habit","status":"active","name":"Synthetic stale CP write","schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean","required":false,"position":0}],"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true},"streakRuleMode":"custom","streakRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true}}}'::jsonb
))->>'status','conflict','the same v8 payload with a stale revision returns a conflict rather than a validation rejection');
select is((select name from public.trackers where id='00000000-0000-4000-8000-000000000410'),'Synthetic CP local edit'::text,
  'stale synthetic CP write leaves the accepted cloud update intact');

select * from finish();
rollback;
