begin;
set local statement_timeout = '60s';
select plan(13);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000005101','holiday-awards@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000005101','UTC',true);
select public.initialize_progression_account('00000000-0000-4000-8000-000000005101');
update public.progression_account_state set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000005101';
update public.progression_achievement_accounts set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000005101';

insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition) values
 ('00000000-0000-4000-8000-000000005111','00000000-0000-4000-8000-000000005101',1,'habit','active','Positive work',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000005111','kind','habit','status','active','name','Positive work',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))),
 ('00000000-0000-4000-8000-000000005112','00000000-0000-4000-8000-000000005101',1,'habit','active','Qualifying zero',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000005112','kind','habit','status','active','name','Qualifying zero',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','decrease','minimum',0))),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','amount','operator','equals','value',0))),
 ('00000000-0000-4000-8000-000000005113','00000000-0000-4000-8000-000000005101',1,'habit','active','Unrelated tracker',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000005113','kind','habit','status','active','name','Unrelated tracker',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','amount','operator','equals','value',0)));

insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000005121','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005111',current_date-2,'recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000005122','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005112',current_date-2,'recorded','{"amount":0}'),
 ('00000000-0000-4000-8000-000000005123','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005113',current_date-2,'recorded','{"amount":0}'),
 ('00000000-0000-4000-8000-000000005124','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005112',current_date-3,'recorded','{"amount":0}'),
 ('00000000-0000-4000-8000-000000005125','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005112',current_date-5,'recorded','{"amount":0}');

select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005121'),10,
  'positive work initially earns daily XP');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),10,
  'a qualifying zero value earns XP when no holiday applies');

insert into public.account_holidays(id,user_id,holiday_date,reason)
values('00000000-0000-4000-8000-000000005131','00000000-0000-4000-8000-000000005101',current_date-2,'personal');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005121'),10,
  'positive progress overrides a newly added global holiday');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),0,
  'qualifying zero progress is reconciled as holiday-exempt');

update public.account_holidays set deleted_at=clock_timestamp()
where id='00000000-0000-4000-8000-000000005131';
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),10,
  'removing the global holiday restores the qualifying zero-value award');

update public.account_holidays set deleted_at=null
where id='00000000-0000-4000-8000-000000005131';
insert into public.tracker_holidays(id,user_id,tracker_id,holiday_date)
values('00000000-0000-4000-8000-000000005133','00000000-0000-4000-8000-000000005101','00000000-0000-4000-8000-000000005112',current_date-2);
update public.account_holidays set deleted_at=clock_timestamp()
where id='00000000-0000-4000-8000-000000005131';
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),0,
  'overlapping selected holiday continues to exempt the tracker after global removal');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005123'),10,
  'selected holiday reconciliation does not affect another tracker');
update public.tracker_holidays set deleted_at=clock_timestamp()
where id='00000000-0000-4000-8000-000000005133';
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),10,
  'deleting the selected holiday restores the affected check-in award');

update public.tracker_holidays set deleted_at=null
where id='00000000-0000-4000-8000-000000005133';
update public.tracker_holidays set tracker_id='00000000-0000-4000-8000-000000005113'
where id='00000000-0000-4000-8000-000000005133';
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005122'),10,
  'reassigning a selected holiday restores the former tracker award');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005123'),0,
  'reassigning a selected holiday reconciles the newly associated tracker');

insert into public.account_holidays(id,user_id,holiday_date,reason)
values('00000000-0000-4000-8000-000000005134','00000000-0000-4000-8000-000000005101',current_date-3,'exam');
update public.account_holidays set holiday_date=current_date-5
where id='00000000-0000-4000-8000-000000005134';
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005124'),10,
  'moving a holiday restores the old-date check-in award');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005125'),0,
  'moving a holiday reconciles the new-date check-in award');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000005101'
  and reason_code='AWARD_REVERSAL'),(select count(distinct reverses_event_id) from public.progression_events
  where user_id='00000000-0000-4000-8000-000000005101' and reason_code='AWARD_REVERSAL'),
  'holiday retries retain one append-only reversal for each award generation');

select * from finish();
rollback;
