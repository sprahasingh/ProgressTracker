begin;
select plan(6);
set local timezone = 'Asia/Kolkata';

insert into auth.users (id,email)
values ('00000000-0000-4000-8000-000000000090','perfect-day-timezone-backfill@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured)
values ('general','00000000-0000-4000-8000-000000000090','UTC',false);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000090';

select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000090','00000000-0000-4000-8000-000000000911','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000091','schema_version',1,'kind','habit','status','active','name','Historic daily tracker',
    'created_at',(current_date - 10)::text||'T00:00:00Z','updated_at',(current_date - 2)::text||'T00:00:00Z',
    'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000091','kind','habit','status','active',
      'createdAt',(current_date - 10)::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('minimum',5,'target',10,'direction','increase'))),'schedule',jsonb_build_object('kind','every-day')))
))->>'status';
select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000090','00000000-0000-4000-8000-000000000912','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000092','tracker_id','00000000-0000-4000-8000-000000000091',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values',jsonb_build_object('amount',5),'created_at',clock_timestamp())
))->>'status';

reset role;
update public.progression_account_state
set initialized_at = ((current_date - 5)::timestamp at time zone 'Asia/Kolkata')
where user_id = '00000000-0000-4000-8000-000000000090';
update public.progression_achievement_accounts
set initialized_at = ((current_date - 5)::timestamp at time zone 'Asia/Kolkata')
where user_id = '00000000-0000-4000-8000-000000000090';
update public.trackers
set updated_at = ((current_date - 2)::timestamp at time zone 'Asia/Kolkata')
where user_id = '00000000-0000-4000-8000-000000000090';

select is((select count(*)::integer from public.progression_events
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'),
  0,'Perfect Day is not evaluated against an unconfigured UTC default');

update public.app_settings
set timezone='Asia/Kolkata', timezone_configured=true
where user_id='00000000-0000-4000-8000-000000000090';

select is((select current_xp from public.progression_award_state
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'
    and effective_date=current_date - 1),
  20,'configuring the account timezone backfills a missed historical local date');
select is((select count(*)::integer from public.progression_events
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'
    and effective_date=current_date - 1),
  1,'the recovered historical occurrence creates one 20 XP award');
select is((select sum(xp_delta)::integer from public.progression_events
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'
    and effective_date=current_date - 1),
  20,'the recovered historical occurrence grants exactly twenty XP');

select public.reconcile_progression_perfect_day('00000000-0000-4000-8000-000000000090',current_date - 1);
select public.reconcile_progression_perfect_day('00000000-0000-4000-8000-000000000090',current_date - 1);
update public.app_settings set timezone='America/Los_Angeles'
where user_id='00000000-0000-4000-8000-000000000090';
select is((select current_xp from public.progression_award_state
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'
    and effective_date=current_date - 1),
  20,'reconciliation repeated after a timezone change remains idempotent');

select is((select count(*)::integer from public.progression_events
  where user_id='00000000-0000-4000-8000-000000000090' and reason_code='PERFECT_DAY_BONUS'
    and effective_date=current_date - 1),
  1,'repeated reconciliation and timezone changes do not duplicate the award');

select * from finish();
rollback;

