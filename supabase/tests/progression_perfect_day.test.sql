begin;
select plan(9);

insert into auth.users (id,email) values ('00000000-0000-4000-8000-000000000088','perfect-day@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured)
values ('general','00000000-0000-4000-8000-000000000088','UTC',true);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000088';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000088','00000000-0000-4000-8000-000000000881','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000880','schema_version',1,'kind','habit','status','active','name','Daily reading',
    'created_at',current_date::text || 'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000880','kind','habit','status','active',
    'createdAt',current_date::text || 'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))
))->>'status','applied'::text,'first eligible tracker is created');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000088','00000000-0000-4000-8000-000000000882','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000883','tracker_id','00000000-0000-4000-8000-000000000880','entry_date',current_date::text,
    'outcome','recorded','entry_values',jsonb_build_object('done',true),'created_at',clock_timestamp())
))->>'status','applied'::text,'today check-in is accepted');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000088' and reason_code='PERFECT_DAY_BONUS'),20::bigint,'one fully completed eligible day earns twenty XP');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000088','00000000-0000-4000-8000-000000000884','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000885','schema_version',1,'kind','goal','status','active','name','Daily exercise',
    'created_at',current_date::text || 'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000885','kind','goal','status','active',
    'createdAt',current_date::text || 'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))
))->>'status','applied'::text,'second eligible tracker is created');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000088' and reason_code='PERFECT_DAY_BONUS'),0,'an incomplete eligible tracker reverses Perfect Day credit');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000088','00000000-0000-4000-8000-000000000886','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000887','tracker_id','00000000-0000-4000-8000-000000000885','entry_date',current_date::text,
    'outcome','recorded','entry_values',jsonb_build_object('done',true),'created_at',clock_timestamp())
))->>'status','applied'::text,'the remaining eligible tracker is completed');
select is((select sum(e.xp_delta) from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000000088' and e.reason_code in ('PERFECT_DAY_BONUS','AWARD_REVERSAL')),20::bigint,'requalification restores one net Perfect Day reward');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000088' and reason_code='PERFECT_DAY_BONUS'),2::bigint,'requalification is represented by a new award generation');
select ok(not exists(select 1 from public.progression_events where user_id='00000000-0000-4000-8000-000000000088' and effective_date>current_date),'future dates cannot earn Perfect Day XP');

select * from finish();
rollback;
