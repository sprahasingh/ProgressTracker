begin;
set local timezone = 'UTC';
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000951','threshold-all-history@example.test'),
  ('00000000-0000-4000-8000-000000000952','threshold-from-today@example.test'),
  ('00000000-0000-4000-8000-000000000953','threshold-after-last@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured) values
  ('general','00000000-0000-4000-8000-000000000951','UTC',true),
  ('general','00000000-0000-4000-8000-000000000952','UTC',true),
  ('general','00000000-0000-4000-8000-000000000953','UTC',true);

with source as (
  select * from (values
    ('00000000-0000-4000-8000-000000000951'::uuid,'00000000-0000-4000-8000-000000000961'::uuid,'All history'),
    ('00000000-0000-4000-8000-000000000952'::uuid,'00000000-0000-4000-8000-000000000962'::uuid,'From today'),
    ('00000000-0000-4000-8000-000000000953'::uuid,'00000000-0000-4000-8000-000000000963'::uuid,'After last check-in')
  ) as rows(user_id,tracker_id,name)
), evaluation as (
  select jsonb_build_object(
    'schedule',jsonb_build_object('kind','every-day'),
    'startDate',(current_date - 30)::text,
    'scheduling',jsonb_build_object('mode','ongoing'),
    'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages',
      'thresholds',jsonb_build_object('direction','increase','target',5))),
    'qualificationRule',jsonb_build_object('kind','threshold','metricId','pages','level','target'),
    'streakRuleMode','same-as-success','strictMode',false
  ) as value
), definitions as (
  select source.*, jsonb_build_object(
    'schemaVersion',10,'id',tracker_id,'name',name,'kind','habit','status','active',
    'startDate',evaluation.value->'startDate','schedule',evaluation.value->'schedule','scheduling',evaluation.value->'scheduling',
    'metrics',evaluation.value->'metrics','qualificationRule',evaluation.value->'qualificationRule',
    'streakRuleMode','same-as-success','strictMode',false,'milestones','[]'::jsonb,'customFields','[]'::jsonb,
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id',tracker_id::text || '-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,
      'application','baseline','recordedAt',clock_timestamp(),'evaluation',evaluation.value
    ))
  ) as definition from source cross join evaluation
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition)
select tracker_id,user_id,10,'habit','active',name,definition from definitions;

insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values
  ('00000000-0000-4000-8000-000000000971','00000000-0000-4000-8000-000000000951','00000000-0000-4000-8000-000000000961',current_date - 1,'recorded','{"pages":4}'::jsonb,'all-history source'),
  ('00000000-0000-4000-8000-000000000972','00000000-0000-4000-8000-000000000952','00000000-0000-4000-8000-000000000962',current_date - 1,'recorded','{"pages":4}'::jsonb,'from-today prior'),
  ('00000000-0000-4000-8000-000000000973','00000000-0000-4000-8000-000000000952','00000000-0000-4000-8000-000000000962',current_date,'recorded','{"pages":4}'::jsonb,'from-today current'),
  ('00000000-0000-4000-8000-000000000974','00000000-0000-4000-8000-000000000953','00000000-0000-4000-8000-000000000963',current_date,'recorded','{"pages":4}'::jsonb,'after-last boundary');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000951';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000961'
), next_eval as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds}',
      '{"direction":"decrease","target":5}'::jsonb) as evaluation from current_tracker
), proposal as (
  select server_revision,definition || jsonb_build_object('metrics',evaluation->'metrics','ruleVersions',jsonb_build_array(
    jsonb_build_object('id','all-history-new','effectiveFrom',(current_date - 30)::text,'revision',2,
      'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',evaluation)
  )) as definition from next_eval
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000951','00000000-0000-4000-8000-000000000981',
    'tracker',server_revision,jsonb_build_object('id','00000000-0000-4000-8000-000000000961','schema_version',10,
      'kind','habit','status','active','name','All history','definition',definition)) as result from proposal
)
select is((select result->>'status' from saved),'applied'::text,'all-history threshold direction change is accepted');
reset role;
select is((select entry_values from public.tracker_entries where id='00000000-0000-4000-8000-000000000971'),
  '{"pages":4}'::jsonb,'all-history evaluation preserves the raw saved check-in value');
select is((select definition->'ruleVersions'->0->'evaluation'->'metrics'->0->'thresholds'->>'direction'
  from public.trackers where id='00000000-0000-4000-8000-000000000961'),
  'decrease'::text,'all-history direction change is effective for the prior date');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000952';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000962'
), next_eval as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,target}','3'::jsonb) as evaluation from current_tracker
), proposal as (
  select server_revision,definition || jsonb_build_object('metrics',evaluation->'metrics','ruleVersions',(definition->'ruleVersions') || jsonb_build_array(
    jsonb_build_object('id','from-today-new','effectiveFrom',current_date::text,'revision',2,
      'application','apply-from-today','historyPolicy','apply-from-today','recordedAt',clock_timestamp(),'evaluation',evaluation)
  )) as definition from next_eval
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000952','00000000-0000-4000-8000-000000000982',
    'tracker',server_revision,jsonb_build_object('id','00000000-0000-4000-8000-000000000962','schema_version',10,
      'kind','habit','status','active','name','From today','definition',definition)) as result from proposal
)
select is((select result->>'status' from saved),'applied'::text,'from-today threshold change is accepted at the workspace date');
reset role;
select is((select definition->'ruleVersions'->0->'evaluation'->'metrics'->0->'thresholds'->>'target'
  from public.trackers where id='00000000-0000-4000-8000-000000000962'),
  '5'::text,'from-today preserves the prior date threshold');
select is((select definition->'ruleVersions'->1->>'effectiveFrom'
  from public.trackers where id='00000000-0000-4000-8000-000000000962'),
  current_date::text,'from-today is inclusive on the workspace date');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000953';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000963'
), next_eval as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds}',
      '{"direction":"decrease","target":5}'::jsonb) as evaluation from current_tracker
), proposal as (
  select server_revision,definition || jsonb_build_object('metrics',evaluation->'metrics','ruleVersions',(definition->'ruleVersions') || jsonb_build_array(
    jsonb_build_object('id','after-last-new','effectiveFrom',(current_date + 1)::text,'revision',2,
      'application','apply-from-today','historyPolicy','after-last-check-in','recordedAt',clock_timestamp(),'evaluation',evaluation)
  )) as definition from next_eval
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000953','00000000-0000-4000-8000-000000000983',
    'tracker',server_revision,jsonb_build_object('id','00000000-0000-4000-8000-000000000963','schema_version',10,
      'kind','habit','status','active','name','After last check-in','definition',definition)) as result from proposal
)
select is((select result->>'status' from saved),'applied'::text,'after-last threshold change starts the day after the latest check-in');
reset role;
select is((select definition->'ruleVersions'->0->'evaluation'->'metrics'->0->'thresholds'->>'direction'
  from public.trackers where id='00000000-0000-4000-8000-000000000963'),
  'increase'::text,'after-last preserves threshold direction on the latest check-in date');
select is((select definition->'ruleVersions'->1->>'effectiveFrom'
  from public.trackers where id='00000000-0000-4000-8000-000000000963'),
  (current_date + 1)::text,'after-last activates the threshold on the day after the latest check-in');

select * from finish();
rollback;
