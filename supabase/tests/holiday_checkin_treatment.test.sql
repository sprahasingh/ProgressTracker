begin;
select plan(12);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000004001','holiday-treatment@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values ('general','00000000-0000-4000-8000-000000004001','UTC',true);
select public.initialize_progression_account('00000000-0000-4000-8000-000000004001');
update public.progression_account_state set initialized_at=(current_date-20)::timestamptz where user_id='00000000-0000-4000-8000-000000004001';
update public.progression_achievement_accounts set initialized_at=(current_date-20)::timestamptz where user_id='00000000-0000-4000-8000-000000004001';

insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition) values
 ('00000000-0000-4000-8000-000000004011','00000000-0000-4000-8000-000000004001',1,'habit','active','Treatment Standard',current_date-20,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000004011','kind','habit','status','active','name','Treatment Standard',
    'createdAt',(current_date-20)::text||'T00:00:00Z','startDate',(current_date-20)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))),
 ('00000000-0000-4000-8000-000000004012','00000000-0000-4000-8000-000000004001',1,'habit','active','Treatment Strict',current_date-20,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000004012','kind','habit','status','active','name','Treatment Strict',
    'createdAt',(current_date-20)::text||'T00:00:00Z','startDate',(current_date-20)::text,'strictMode',true,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true)));

insert into public.account_holidays(id,user_id,holiday_date,reason)
values ('00000000-0000-4000-8000-000000004021','00000000-0000-4000-8000-000000004001',current_date-2,'personal');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,holiday_treatment) values
 ('00000000-0000-4000-8000-000000004031','00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000004011',current_date-2,'recorded','{"done":true}','keep-holiday');
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000004001',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000004011'),current_date-2),
  'Keep as Holiday remains neutral even when recorded work qualifies');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000004001' and source_id='00000000-0000-4000-8000-000000004031' and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
  'Keep as Holiday does not award daily completion XP');

update public.tracker_entries set holiday_treatment='count-normal' where id='00000000-0000-4000-8000-000000004031';
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000004001',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000004011'),current_date-2),
  'Count as Normal Check-in restores the scheduled opportunity');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000004001' and source_id='00000000-0000-4000-8000-000000004031' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
  'treatment edits reconcile the existing qualifying check-in award');
update public.tracker_entries set holiday_treatment='keep-holiday' where id='00000000-0000-4000-8000-000000004031';
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000004001' and source_id='00000000-0000-4000-8000-000000004031' and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
  'switching back reverses XP through reconciliation');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000004001' and reason_code='AWARD_REVERSAL'),1::bigint,
  'treatment reversal is append-only and emitted once');

insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,holiday_treatment) values
 ('00000000-0000-4000-8000-000000004032','00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000004011',current_date-3,'recorded','{"done":true}',null);
insert into public.account_holidays(id,user_id,holiday_date,reason)
values ('00000000-0000-4000-8000-000000004022','00000000-0000-4000-8000-000000004001',current_date-3,'personal');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000004001',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000004011'),current_date-3),
  'legacy null treatment preserves positive-work holiday override');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000004001',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000004012'),current_date-2),
  'Strict Mode remains an opportunity through a holiday');
select throws_ok($$insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,holiday_treatment)
  values ('00000000-0000-4000-8000-000000004033','00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000004012',current_date-2,'recorded','{"done":true}','keep-holiday')$$,
  '22023','Strict Mode check-ins cannot set a holiday treatment','Strict Mode cannot persist a holiday treatment');
select is((select count(*) from public.tracker_entries where user_id='00000000-0000-4000-8000-000000004001' and holiday_treatment is null),1::bigint,
  'historical entries remain null rather than being silently backfilled');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000004001';
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000004041','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000004042','tracker_id','00000000-0000-4000-8000-000000004011',
    'entry_date',(current_date-4)::text,'outcome','recorded','entry_values','{"done":true}'::jsonb,
    'created_at',now()::text,'updated_at',now()::text,'deleted_at',null,'holiday_treatment','count-normal')
))->>'status','applied','sync RPC persists the explicit holiday treatment');
select is(public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000004043','tracker_entry',
  (select server_revision from public.tracker_entries where id='00000000-0000-4000-8000-000000004042'),
  jsonb_build_object('id','00000000-0000-4000-8000-000000004042','tracker_id','00000000-0000-4000-8000-000000004011',
    'entry_date',(current_date-4)::text,'outcome','recorded','entry_values','{"done":true}'::jsonb,
    'created_at',now()::text,'updated_at',now()::text,'deleted_at',null)
)#>>'{record,holiday_treatment}','count-normal','older sync payloads that omit the preference preserve it');
reset role;

select * from finish();
rollback;
