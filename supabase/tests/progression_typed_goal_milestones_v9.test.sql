begin;
select plan(14);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000092', 'typed-goal-milestone@example.test');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000092';

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000920','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000921','schema_version',9,'kind','goal','status','active','name','Solve problems',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',9,'id','00000000-0000-4000-8000-000000000921','kind','goal','status','active','name','Solve problems',
   'createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-2)::text,'metrics',jsonb_build_array(jsonb_build_object('id','problems','name','Problems','valueType','quantity','unit','problems','thresholds',jsonb_build_object('direction','increase','streakQualification','any-recorded-value'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
   'milestones',jsonb_build_array(jsonb_build_object('id','total-10','title','First ten','description','','type','cumulative-quantity','metricId','problems','targetValue',10,'measureTypeSnapshot','quantity','unitSnapshot','problems','position',0))))
))->>'status','applied'::text,'schema v9 goal tracker with typed milestone is accepted');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000922','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000923','tracker_id','00000000-0000-4000-8000-000000000921','entry_date',(current_date-1)::text,
  'outcome','recorded','entry_values',jsonb_build_object('problems',4),'created_at',clock_timestamp())
))->>'status','applied'::text,'first cumulative observation is accepted');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000924','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000925','tracker_id','00000000-0000-4000-8000-000000000921','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('problems',6),'created_at',clock_timestamp())
))->>'status','applied'::text,'threshold-crossing observation is accepted');
reset role;

select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),25,
  'typed cumulative goal milestone uses the existing 25 XP reward policy');
select is((select effective_date from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),current_date,
  'typed cumulative reward records the historical threshold-crossing date');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),1::bigint,
  'one typed milestone crossing creates one reward event');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000926','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000925','tracker_id','00000000-0000-4000-8000-000000000921','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('problems',2),'created_at',clock_timestamp())
))->>'status','applied'::text,'editing a historical quantity is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),0,
  'editing history below the target reverses the typed milestone reward');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000092' and reason_code='AWARD_REVERSAL'),1::bigint,
  'the edit creates one auditable reward reversal');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000927','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000923','tracker_id','00000000-0000-4000-8000-000000000921','entry_date',(current_date-1)::text,
  'outcome','recorded','entry_values',jsonb_build_object('problems',10),'created_at',clock_timestamp())
))->>'status','applied'::text,'historical backfill correction is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),25,
  'a corrected historical crossing restores the reward');
select is((select effective_date from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),current_date-1,
  'recalculation moves the reward date to the first historical crossing');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000092' and reason_code='GOAL_MILESTONE'),2::bigint,
  'requalification is recorded as a new idempotent generation');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000092' and reason_code in ('GOAL_MILESTONE','AWARD_REVERSAL')),25::bigint,
  'reconciliation leaves one net milestone reward after edits');

select * from finish();
rollback;
