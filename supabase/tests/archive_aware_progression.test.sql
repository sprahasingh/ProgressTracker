begin;
set local statement_timeout = '60s';
select plan(28);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000003901','archive-eligibility@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000003901','UTC',true);
select public.initialize_progression_account('00000000-0000-4000-8000-000000003901');
update public.progression_account_state set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000003901';
update public.progression_achievement_accounts set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000003901';

insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition) values
 ('00000000-0000-4000-8000-000000003911','00000000-0000-4000-8000-000000003901',1,'habit','active','Archive Standard',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000003911','kind','habit','status','active','name','Archive Standard',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))),
 ('00000000-0000-4000-8000-000000003912','00000000-0000-4000-8000-000000003901',1,'habit','active','Archive Strict',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000003912','kind','habit','status','active','name','Archive Strict',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'strictMode',true,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))),
 ('00000000-0000-4000-8000-000000003913','00000000-0000-4000-8000-000000003901',1,'habit','active','Remaining Standard',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000003913','kind','habit','status','active','name','Remaining Standard',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true)));

insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000003920','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911',current_date-4,'recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000003921','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911',current_date-3,'recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000003922','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911',current_date-1,'recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000003924','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911',current_date-2,'recorded','{"done":true}');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000003925','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003913',current_date-1,'recorded','{"done":true}');

insert into public.account_holidays(id,user_id,holiday_date,reason)
values('00000000-0000-4000-8000-000000003931','00000000-0000-4000-8000-000000003901',current_date-3,'personal');
insert into public.account_holidays(id,user_id,holiday_date,reason)
values('00000000-0000-4000-8000-000000003933','00000000-0000-4000-8000-000000003901',current_date-5,'personal');
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-5),
  'global holiday excuses a missing Standard Mode check-in');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003912'),current_date-3),
  'global holiday does not excuse Strict Mode');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-3),
  'positive work overrides a global holiday for its tracker and date');
update public.tracker_entries set entry_values='{"done":false}' where id='00000000-0000-4000-8000-000000003921';
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-3),
  'zero work restores the global holiday exemption');
update public.tracker_entries set outcome='skipped' where id='00000000-0000-4000-8000-000000003921';
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-3),
  'Skip restores the global holiday exemption');

select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000003901',current_date-1),'unsupported'::text,
  'legacy tracker update boundaries keep the historical Perfect Day unsupported before archive reconciliation');
update public.trackers set status='archived', definition=definition||jsonb_build_object('status','archived','archivedAt',(current_date-2)::text||'T15:00:00Z')
where id='00000000-0000-4000-8000-000000003911';
update public.trackers set status='archived', definition=definition||jsonb_build_object('status','archived','archivedAt',(current_date-2)::text||'T15:00:00Z')
where id='00000000-0000-4000-8000-000000003912';
select is((select count(*) from public.private_progression_archive_reconciliation_jobs where user_id='00000000-0000-4000-8000-000000003901'),2::bigint,
  'archive changes queue bounded reconciliation for each affected tracker');
select public.process_progression_archive_reconciliation_batch(500);
select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000003901',current_date-1),'unsupported'::text,
  'archive reconciliation preserves the unsupported legacy Perfect Day instead of rescoring it under newer rules');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000003901'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=current_date-1),0::bigint,
  'archive reconciliation does not invent a legacy Perfect Day award');
select is((select count(*) from public.private_progression_archive_reconciliation_jobs where user_id='00000000-0000-4000-8000-000000003901'),0::bigint,
  'bounded archive reconciliation drains all fixture work');
select is(public.process_progression_archive_reconciliation_batch(500)->>'processed','0',
  'repeating a completed archive reconciliation is an idempotent no-op');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-4),
  'Standard Mode remains eligible before the archive date');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-2),
  'the archive date itself remains eligible in Standard Mode');
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-1),
  'Standard Mode is ineligible after the archive date');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003912'),current_date-4),
  'Strict Mode remains required before the archive date');
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003912'),current_date-2),
  'Strict Mode remains required on the archive date');
select ok(not public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003912'),current_date-1),
  'Strict Mode is inactive after the archive date');
insert into public.tracker_holidays(id,user_id,tracker_id,holiday_date)
values('00000000-0000-4000-8000-000000003932','00000000-0000-4000-8000-000000003901','00000000-0000-4000-8000-000000003911',current_date-2);
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-2),
  'positive work keeps the archive date eligible despite its selected holiday');

select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000003901'
  and tracker_id='00000000-0000-4000-8000-000000003911' and source_id='00000000-0000-4000-8000-000000003921' and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
  'editing a tracker to archived reverses XP for positive work after the archive date');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000003901'
  and tracker_id='00000000-0000-4000-8000-000000003911' and source_id='00000000-0000-4000-8000-000000003920' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
  'archiving preserves a legitimate award from before the archive boundary');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000003901'
  and tracker_id='00000000-0000-4000-8000-000000003911' and source_id='00000000-0000-4000-8000-000000003924' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
  'the archive date itself retains its legitimate daily award');
select ok(exists(select 1 from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000003901'
  and e.reason_code='AWARD_REVERSAL' and e.xp_delta<0 and e.reverses_event_id in (
    select award.id from public.progression_events award join public.progression_event_sources s on s.user_id=award.user_id and s.event_id=award.id
    where s.source_id='00000000-0000-4000-8000-000000003922')),
  'archive reconciliation preserves an append-only reversal for the invalid award');
select is((select count(*) from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000003901'
  and e.reason_code='AWARD_REVERSAL' and e.reverses_event_id in (
    select award.id from public.progression_events award join public.progression_event_sources s on s.user_id=award.user_id and s.event_id=award.id
    where s.source_id='00000000-0000-4000-8000-000000003922')),
  1::bigint,'repeated archive reconciliation does not append duplicate reversals');

update public.trackers set status='active', definition=(definition-'archivedAt')||'{"status":"active"}'::jsonb
where id='00000000-0000-4000-8000-000000003911';
select public.process_progression_archive_reconciliation_batch(500);
select ok(public.progression_date_is_eligible('00000000-0000-4000-8000-000000003901',(select t from public.trackers t where t.id='00000000-0000-4000-8000-000000003911'),current_date-1),
  'unarchiving removes the active archive boundary consistently with the frontend');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000003901'
  and tracker_id='00000000-0000-4000-8000-000000003911' and source_id='00000000-0000-4000-8000-000000003922' and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
  'unarchiving restores the previously reversed check-in award');
update public.trackers set status='archived', definition=definition||jsonb_build_object('status','archived','archivedAt',(current_date-2)::text||'T15:00:00Z')
where id='00000000-0000-4000-8000-000000003911';
select public.process_progression_archive_reconciliation_batch(500);
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000003901'
  and tracker_id='00000000-0000-4000-8000-000000003911' and source_id='00000000-0000-4000-8000-000000003922' and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
  'rearchiving at the original boundary reverses only the restored post-boundary award');
select is((select count(*) from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000003901'
  and e.reason_code='AWARD_REVERSAL' and e.reverses_event_id in (
    select award.id from public.progression_events award join public.progression_event_sources s on s.user_id=award.user_id and s.event_id=award.id
    where s.source_id='00000000-0000-4000-8000-000000003922')),
  2::bigint,'rearchiving reverses the restored award generation without deleting history');
select public.process_progression_archive_reconciliation_batch(500);
select is((select count(*) from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000003901'
  and e.reason_code='AWARD_REVERSAL' and e.reverses_event_id in (
    select award.id from public.progression_events award join public.progression_event_sources s on s.user_id=award.user_id and s.event_id=award.id
    where s.source_id='00000000-0000-4000-8000-000000003922')),
  2::bigint,'repeating rearchive reconciliation does not append duplicate reversals');

select * from finish();
rollback;
