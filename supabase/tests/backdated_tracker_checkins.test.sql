begin;
select plan(10);

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000881','backdated-checkins@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000000881','UTC',true)
on conflict(user_id) do update set timezone='UTC',timezone_configured=true;
update public.progression_account_state set initialized_at=(current_date-5)::timestamptz
where user_id='00000000-0000-4000-8000-000000000881';
update public.progression_achievement_accounts set initialized_at=(current_date-5)::timestamptz
where user_id='00000000-0000-4000-8000-000000000881';

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000881';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000882','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000883','schema_version',1,'kind','habit','status','active','name','Backdated start',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000883','kind','habit','status','active',
   'createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-3)::text,'deadline',current_date::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))
))->>'status','applied','tracker created today may explicitly start earlier');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000884','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000885','tracker_id','00000000-0000-4000-8000-000000000883',
  'entry_date',(current_date-2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true),
  'created_at',(current_date-2)::text||'T12:00:00Z')
))->>'status','applied','eligible historical check-in before creation is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000881'
 and source_id='00000000-0000-4000-8000-000000000885' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
 'accepted historical check-in earns its normal XP award');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000886','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000885','tracker_id','00000000-0000-4000-8000-000000000883',
  'entry_date',(current_date-2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',false))
))->>'status','applied','historical edit is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000881'
 and source_id='00000000-0000-4000-8000-000000000885' and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
 'editing historical success reverses its active XP');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000887','tracker_entry',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000885','tracker_id','00000000-0000-4000-8000-000000000883',
  'entry_date',(current_date-2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true))
))->>'status','applied','restoring historical success is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000881'
 and source_id='00000000-0000-4000-8000-000000000885' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
 'restoring historical success restores XP exactly once');

set local role authenticated;
select throws_ok($$select public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000888','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000889','tracker_id','00000000-0000-4000-8000-000000000883',
  'entry_date',(current_date-4)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true)))$$,
 '23514','Check-in date is before the tracker start date.','check-ins before explicit start are rejected');
select throws_ok($$select public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000890','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000891','tracker_id','00000000-0000-4000-8000-000000000883',
  'entry_date',(current_date+1)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true)))$$,
 '23514','Check-ins can only be saved for today or an earlier date in the account timezone.','future check-ins are rejected');
reset role;
select throws_ok($$insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome)
 values('00000000-0000-4000-8000-000000000892','00000000-0000-4000-8000-000000000881','00000000-0000-4000-8000-000000000893',current_date,'recorded')$$,
 '23503',null,'a missing tracker cannot bypass owner-reference integrity');

select * from finish();
rollback;
