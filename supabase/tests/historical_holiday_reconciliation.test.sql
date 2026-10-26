begin;
select plan(12);

select ok(exists(select 1 from pg_trigger where tgrelid='public.account_holidays'::regclass
  and tgname='account_holidays_reconcile_progression' and not tgisinternal
  and (tgtype & 16)=16 and (tgtype & 8)=8),
  'account holiday reconciliation runs after update and delete as well as insert');
select ok(exists(select 1 from pg_trigger where tgrelid='public.tracker_holidays'::regclass
  and tgname='tracker_holidays_reconcile_progression' and not tgisinternal
  and (tgtype & 16)=16 and (tgtype & 8)=8),
  'tracker holiday reconciliation runs after update and delete as well as insert');
select ok(position('old.holiday_date' in pg_get_functiondef('public.reconcile_account_holiday_change()'::regprocedure))>0
  and position('new.holiday_date' in pg_get_functiondef('public.reconcile_account_holiday_change()'::regprocedure))>0,
  'account holiday updates retain both the prior and replacement dates for reconciliation');
select ok(position('old.holiday_date' in pg_get_functiondef('public.reconcile_tracker_holiday_change()'::regprocedure))>0
  and position('new.holiday_date' in pg_get_functiondef('public.reconcile_tracker_holiday_change()'::regprocedure))>0,
  'tracker holiday updates retain both the prior and replacement dates for reconciliation');
select ok(position('old.tracker_id' in pg_get_functiondef('public.reconcile_tracker_holiday_change()'::regprocedure))>0
  and position('new.tracker_id' in pg_get_functiondef('public.reconcile_tracker_holiday_change()'::regprocedure))>0,
  'tracker reassignment reconciles both affected trackers');
select ok(position('reconcile_progression_tracker_milestones' in pg_get_functiondef('public.reconcile_account_holiday_change()'::regprocedure))>0,
  'global holiday changes refresh tracker milestone progression');
select ok(position('reconcile_progression_perfect_day' in pg_get_functiondef('public.reconcile_account_holiday_change()'::regprocedure))>0
  and position('reconcile_progression_achievements' in pg_get_functiondef('public.reconcile_account_holiday_change()'::regprocedure))>0,
  'global holiday changes refresh affected Perfect Days and dependent achievements');
select ok(position('reconcile_progression_achievements' in pg_get_functiondef('public.reconcile_tracker_holiday_change()'::regprocedure))>0,
  'selected holiday changes reconcile dependent achievements');

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000004101','holiday-reconciliation@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000004101','UTC',true);
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition) values
 ('00000000-0000-4000-8000-000000004111','00000000-0000-4000-8000-000000004101',1,'habit','active','Holiday reconciliation',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000004111","kind":"habit","status":"active","name":"Holiday reconciliation","createdAt":"2026-01-01T00:00:00Z","startDate":"2026-01-01","schedule":{"kind":"every-day"},"metrics":[{"id":"done","name":"Done","valueType":"boolean"}]}');

insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable,updated_at)
values('00000000-0000-4000-8000-000000004101','first-step',0,1,0,false,'2000-01-01T00:00:00Z')
on conflict(user_id,achievement_id) do update set updated_at='2000-01-01T00:00:00Z';
insert into public.account_holidays(id,user_id,holiday_date,reason)
values('00000000-0000-4000-8000-000000004121','00000000-0000-4000-8000-000000004101',current_date-3,'personal');
select ok((select updated_at>'2000-01-01T00:00:00Z' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step'),
  'inserting a past global holiday refreshes achievement state');

update public.progression_achievement_progress set updated_at='2000-01-01T00:00:00Z'
where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step';
update public.account_holidays set holiday_date=current_date-2 where id='00000000-0000-4000-8000-000000004121';
select ok((select updated_at>'2000-01-01T00:00:00Z' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step'),
  'editing a past global holiday date refreshes achievement state');

update public.progression_achievement_progress set updated_at='2000-01-01T00:00:00Z'
where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step';
insert into public.tracker_holidays(id,user_id,tracker_id,holiday_date)
values('00000000-0000-4000-8000-000000004131','00000000-0000-4000-8000-000000004101','00000000-0000-4000-8000-000000004111',current_date-3);
select ok((select updated_at>'2000-01-01T00:00:00Z' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step'),
  'inserting a past selected holiday refreshes achievement state');

update public.progression_achievement_progress set updated_at='2000-01-01T00:00:00Z'
where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step';
update public.tracker_holidays set deleted_at=clock_timestamp() where id='00000000-0000-4000-8000-000000004131';
select ok((select updated_at>'2000-01-01T00:00:00Z' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000004101' and achievement_id='first-step'),
  'deleting a past selected holiday refreshes achievement state');

select * from finish();
rollback;
