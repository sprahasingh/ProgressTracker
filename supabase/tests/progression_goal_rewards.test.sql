begin;
select plan(15);
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000077','goal-reward@example.test');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000077';

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000770','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000771','schema_version',1,'kind','goal','status','active','name','Finish course',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000771','kind','goal','status','active',
   'createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-1)::text,'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','thresholds',jsonb_build_object('direction','increase','streakQualification','any-recorded-value'))),
   'schedule',jsonb_build_object('kind','every-day'),'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'goal tracker is accepted');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000772','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000773','tracker_id','00000000-0000-4000-8000-000000000771','entry_date',(current_date-1)::text,
  'outcome','recorded','entry_values',jsonb_build_object('pages',4),'created_at',clock_timestamp())
))->>'status','applied'::text,'first metric observation is accepted');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000774','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000775','tracker_id','00000000-0000-4000-8000-000000000771','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('pages',12),'created_at',clock_timestamp())
))->>'status','applied'::text,'milestone observation is accepted');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_MILESTONE'),25::bigint,'crossing one configured goal checkpoint awards once');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000776','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000775','tracker_id','00000000-0000-4000-8000-000000000771','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('pages',2),'created_at',clock_timestamp())
))->>'status','applied'::text,'historical correction is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_MILESTONE'),0,'correction below best checkpoint reverses credit');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000777','tracker_entry',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000775','tracker_id','00000000-0000-4000-8000-000000000771','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('pages',12),'created_at',clock_timestamp())
))->>'status','applied'::text,'requalification is accepted');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000077' and reason_code in ('GOAL_MILESTONE','AWARD_REVERSAL')),25::bigint,'requalification restores one net checkpoint reward');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000778','tracker',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000771','schema_version',1,'kind','goal','status','completed','name','Finish course',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000771','kind','goal','status','completed',
   'createdAt',current_date::text||'T00:00:00Z','completedAt',clock_timestamp(),'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','thresholds',jsonb_build_object('direction','increase','streakQualification','any-recorded-value'))),
   'schedule',jsonb_build_object('kind','every-day'),'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'goal completion status is accepted');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_COMPLETED'),100::bigint,'completed goal earns one hundred XP');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_MILESTONE'),0,'completion suppresses the overlapping checkpoint award');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_COMPLETED'),100,'completion credit is authoritative');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000077','00000000-0000-4000-8000-000000000779','tracker',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000771','schema_version',1,'kind','goal','status','active','name','Finish course',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000771','kind','goal','status','active',
   'createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','thresholds',jsonb_build_object('direction','increase','streakQualification','any-recorded-value'))),
   'schedule',jsonb_build_object('kind','every-day'),'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'reopening the goal is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_COMPLETED'),0,'reopening reverses completion XP');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000077' and reason_code='GOAL_MILESTONE'),25,'reopening restores the checkpoint reward');
set local role authenticated;
select * from finish();
rollback;
