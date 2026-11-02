begin;
select plan(20);
set local timezone = 'UTC';

insert into auth.users (id,email) values
  ('00000000-0000-4000-8000-000000000981','precision-divergent@example.test'),
  ('00000000-0000-4000-8000-000000000982','precision-matching@example.test'),
  ('00000000-0000-4000-8000-000000000983','precision-forward@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured) values
  ('general','00000000-0000-4000-8000-000000000981','UTC',true),
  ('general','00000000-0000-4000-8000-000000000982','UTC',true),
  ('general','00000000-0000-4000-8000-000000000983','UTC',true);

with source as (
  select * from (values
    ('00000000-0000-4000-8000-000000000981'::uuid,'00000000-0000-4000-8000-000000000991'::uuid,'divergent',false),
    ('00000000-0000-4000-8000-000000000982'::uuid,'00000000-0000-4000-8000-000000000992'::uuid,'matching',true),
    ('00000000-0000-4000-8000-000000000983'::uuid,'00000000-0000-4000-8000-000000000993'::uuid,'forward',true)
  ) as rows(user_id,tracker_id,tag,matching_precision)
), metrics as (
  select source.*,
    jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages',
      'thresholds',jsonb_build_object('direction','increase','target',5)) as old_metric,
    jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages',
      'precision',jsonb_build_object('decimalPlaces',1,'increment',0.1),
      'thresholds',jsonb_build_object('direction','increase','target',5)) as current_metric
  from source
), definitions as (
  select metrics.*,
    jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'startDate',(current_date - 30)::text,
      'scheduling',jsonb_build_object('mode','ongoing'),'metrics',jsonb_build_array(old_metric),
      'qualificationRule',jsonb_build_object('kind','threshold','metricId','pages','level','target'),
      'streakRuleMode','same-as-success','strictMode',false) as old_eval,
    jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'startDate',(current_date - 30)::text,
      'scheduling',jsonb_build_object('mode','ongoing'),'metrics',jsonb_build_array(current_metric),
      'qualificationRule',jsonb_build_object('kind','threshold','metricId','pages','level','target'),
      'streakRuleMode','same-as-success','strictMode',false) as current_eval
  from metrics
), inserted as (
  insert into public.trackers (id,user_id,schema_version,kind,status,name,definition)
  select tracker_id,user_id,10,'habit','active','Precision '||tag,
    jsonb_build_object('schemaVersion',10,'id',tracker_id,'name','Precision '||tag,'kind','habit','status','active',
      'startDate',(current_date - 30)::text,'schedule',current_eval->'schedule','scheduling',current_eval->'scheduling',
      'metrics',current_eval->'metrics','qualificationRule',current_eval->'qualificationRule','streakRuleMode','same-as-success',
      'strictMode',false,'customFields','[]'::jsonb,'milestones','[]'::jsonb,
      'ruleVersions',case when matching_precision then jsonb_build_array(
        jsonb_build_object('id',tracker_id::text||'-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,'application','baseline','recordedAt',clock_timestamp(),'evaluation',current_eval),
        jsonb_build_object('id',tracker_id::text||'-next','effectiveFrom',(current_date - 10)::text,'revision',2,'application','apply-from-today','recordedAt',clock_timestamp(),'evaluation',current_eval)
      ) else jsonb_build_array(
        jsonb_build_object('id',tracker_id::text||'-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,'application','baseline','recordedAt',clock_timestamp(),'evaluation',old_eval),
        jsonb_build_object('id',tracker_id::text||'-next','effectiveFrom',(current_date - 10)::text,'revision',2,'application','apply-from-today','recordedAt',clock_timestamp(),'evaluation',current_eval)
      ) end)
  from definitions returning id,user_id
)
insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
select '00000000-0000-4000-8000-000000000994',user_id,id,current_date - 1,'recorded','{"pages":1.2}'::jsonb,'raw precision-boundary value'
from inserted where id='00000000-0000-4000-8000-000000000993';
insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000000998','00000000-0000-4000-8000-000000000982',
  '00000000-0000-4000-8000-000000000992',current_date,'recorded','{"pages":4}'::jsonb,'all-history award source');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000981';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000991'
), evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,direction}','"decrease"'::jsonb) as next_eval
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000981','00000000-0000-4000-8000-000000000995','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000991','schema_version',10,'kind','habit','status','active',
      'name','Precision divergent','definition',definition || jsonb_build_object('metrics',next_eval->'metrics','ruleVersions',jsonb_build_array(
        jsonb_build_object('id','precision-divergent-all','effectiveFrom',(current_date - 30)::text,'revision',3,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',next_eval))))) as result
  from evaluation
)
select is((select result->>'status' from saved),'conflict'::text,'all-history threshold edit rejects a divergent historical precision snapshot');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000982';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000992'
), evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,direction}','"decrease"'::jsonb) as next_eval
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000996','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000992','schema_version',10,'kind','habit','status','active',
      'name','Precision matching','definition',definition || jsonb_build_object('metrics',next_eval->'metrics','ruleVersions',jsonb_build_array(
        jsonb_build_object('id','precision-matching-all','effectiveFrom',(current_date - 30)::text,'revision',3,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',next_eval))))) as result
  from evaluation
)
select is((select result->>'status' from saved),'applied'::text,'threshold-only all-history edit is accepted when all precisions match');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000982' and source_id='00000000-0000-4000-8000-000000000998'),
  10,'all-history edit grants XP when the saved check-in newly qualifies');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000982'
  and achievement_id='first-step' and event_type='unlocked'),1::bigint,'all-history qualification unlocks its earned achievement');
select public.record_progression_entry_award('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000992',
  '00000000-0000-4000-8000-000000000998',current_date,'{"pages":4}'::jsonb,'recorded',null);
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000982'
  and reason_code='DAILY_CHECK_IN_COMPLETED' and idempotency_key=md5('00000000-0000-4000-8000-000000000982:00000000-0000-4000-8000-000000000998:daily-check-in-v1')::uuid),
  1::bigint,'repeating all-history award reconciliation does not duplicate XP events');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000982';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000992'
), evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,direction}','"increase"'::jsonb) as next_eval
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000999','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000992','schema_version',10,'kind','habit','status','active',
      'name','Precision matching','definition',definition || jsonb_build_object('metrics',next_eval->'metrics','ruleVersions',jsonb_build_array(
        jsonb_build_object('id','precision-matching-reverse','effectiveFrom',(current_date - 30)::text,'revision',4,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',next_eval))))) as result
  from evaluation
)
select is((select result->>'status' from saved),'applied'::text,'all-history edit that removes qualification is applied transactionally');
reset role;
select is((select count(*) from public.progression_events reversal join public.progression_events award
  on award.user_id=reversal.user_id and award.id=reversal.reverses_event_id
  where reversal.user_id='00000000-0000-4000-8000-000000000982' and reversal.reason_code='AWARD_REVERSAL'
    and award.reason_code='DAILY_CHECK_IN_COMPLETED'),1::bigint,'all-history edit appends one valid reversal for the prior award');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000982'
  and achievement_id='first-step' and event_type='revoked'),1::bigint,'all-history dequalification appends an achievement revocation');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000982';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000992'
), evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,direction}','"decrease"'::jsonb) as next_eval
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000910','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000992','schema_version',10,'kind','habit','status','active',
      'name','Precision matching','definition',definition || jsonb_build_object('metrics',next_eval->'metrics','ruleVersions',jsonb_build_array(
        jsonb_build_object('id','precision-matching-regrant','effectiveFrom',(current_date - 30)::text,'revision',5,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',next_eval))))) as result
  from evaluation
)
select is((select result->>'status' from saved),'applied'::text,'all-history retry after reversal can restore qualification');
reset role;
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000982'
  and reason_code='DAILY_CHECK_IN_COMPLETED' and xp_delta=10),2::bigint,'requalification creates a new append-only award generation');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000982' and source_id='00000000-0000-4000-8000-000000000998'),
  10,'requalification restores exactly one active XP award');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000982'
  and achievement_id='first-step' and event_type='unlocked'),2::bigint,'requalification grants a new achievement generation after revocation');

create function pg_temp.fail_tracker_edit_after_progression() returns trigger
language plpgsql as $$
begin
  if new.id='00000000-0000-4000-8000-000000000992'::uuid then
    raise exception using errcode='P0001',message='forced all-history transaction rollback';
  end if;
  return new;
end;
$$;
create trigger zzz_test_fail_after_tracker_reconciliation
after update on public.trackers
for each row execute function pg_temp.fail_tracker_edit_after_progression();

create function pg_temp.attempt_precision_rollback() returns void
language plpgsql as $$
declare
  v_tracker public.trackers%rowtype;
  v_evaluation jsonb;
begin
  select * into v_tracker from public.trackers where id='00000000-0000-4000-8000-000000000992';
  v_evaluation := jsonb_set(v_tracker.definition->'ruleVersions'->-1->'evaluation',
    '{metrics,0,thresholds,direction}','"increase"'::jsonb);
  perform public.apply_tracker_sync_operation(
    '00000000-0000-4000-8000-000000000982',
    '00000000-0000-4000-8000-000000000911',
    'tracker',
    v_tracker.server_revision,
    jsonb_build_object(
      'id',v_tracker.id,'schema_version',10,'kind','habit','status','active','name','Precision matching',
      'definition',v_tracker.definition || jsonb_build_object(
        'metrics',jsonb_set(v_tracker.definition->'metrics','{0,thresholds,direction}','"increase"'::jsonb),
        'ruleVersions',jsonb_build_array(jsonb_build_object(
          'id','precision-rollback','effectiveFrom',(current_date - 30)::text,'revision',6,
          'application','recalculate-all-history','historyPolicy','recalculate-all-history',
          'recordedAt',clock_timestamp(),'evaluation',v_evaluation)))));
end;
$$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000982';
select throws_ok('select pg_temp.attempt_precision_rollback()',
  'P0001','forced all-history transaction rollback',
  'a failure after progression reconciliation aborts the complete tracker edit');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000982' and source_id='00000000-0000-4000-8000-000000000998'),
  10,'rollback leaves the prior XP award intact without a partial reversal');

drop trigger zzz_test_fail_after_tracker_reconciliation on public.trackers;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000982';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000992'
), evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,thresholds,direction}','"increase"'::jsonb) as next_eval
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000911','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000992','schema_version',10,'kind','habit','status','active',
      'name','Precision matching','definition',definition || jsonb_build_object('metrics',next_eval->'metrics','ruleVersions',jsonb_build_array(
        jsonb_build_object('id','precision-rollback-retry','effectiveFrom',(current_date - 30)::text,'revision',6,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',next_eval))))) as result
  from evaluation
)
select is((select result->>'status' from saved),'applied'::text,'retry after rollback applies the edit and reconciles progression');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000982' and source_id='00000000-0000-4000-8000-000000000998'),
  0,'successful retry completes the reversal atomically');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000983';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000993'
), next_eval as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics,0,precision,increment}','0.5'::jsonb) as evaluation
  from current_tracker
), saved as (
  select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000983','00000000-0000-4000-8000-000000000997','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000993','schema_version',10,'kind','habit','status','active',
      'name','Precision forward','definition',definition || jsonb_build_object('metrics',evaluation->'metrics','ruleVersions',(definition->'ruleVersions') || jsonb_build_array(
        jsonb_build_object('id','precision-forward-today','effectiveFrom',current_date::text,'revision',3,'application','apply-from-today','historyPolicy','apply-from-today','recordedAt',clock_timestamp(),'evaluation',evaluation))))) as result
  from next_eval
)
select is((select result->>'status' from saved),'applied'::text,'forward-effective precision change remains supported');

select is((select jsonb_build_array(entry_date,entry_values,note) from public.tracker_entries where id='00000000-0000-4000-8000-000000000994'),
  jsonb_build_array(current_date - 1,'{"pages":1.2}'::jsonb,'raw precision-boundary value'),
  'forward precision change preserves saved check-in date, raw value, and note');

select ok(position('v_historical_metric->''precision''' in pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure)) > 0,
  'authenticated sync guard compares historical precision');
select ok(position('current_metric.value->''thresholds'' is distinct from proposed_metric.value->''thresholds''' in pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure)) > 0,
  'all-history precision validation includes threshold-edited measures outside the rule dependency set');

select * from finish();
rollback;
