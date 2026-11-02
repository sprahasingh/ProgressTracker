begin;
set local timezone = 'UTC';
set local statement_timeout = '60s';
select plan(49);

select has_function('public','reconcile_missing_perfect_days',array['uuid'],'missing Perfect Day recovery is a private internal function');
select ok(not has_function_privilege('authenticated','public.reconcile_missing_perfect_days(uuid)','execute'),
  'authenticated clients cannot invoke the internal date scan directly');
select has_function('public','reconcile_current_perfect_days',array['integer'],'the scheduled current-date worker exists');
select has_index('public','tracker_entries','tracker_entries_live_date_user_idx','current-date worker has a bounded live-date index');
select ok(not has_function_privilege('authenticated','public.reconcile_current_perfect_days(integer)','execute'),
  'authenticated clients cannot invoke the global reconciliation worker');
select ok(position('progression_local_date(v_now,v_timezone)' in pg_get_functiondef('public.reconcile_current_perfect_days(integer)'::regprocedure))>0,
  'scheduled recovery compares dates in each account timezone');
select ok(position('greatest(1,least(coalesce(p_limit,50),50))' in pg_get_functiondef('public.reconcile_current_perfect_days(integer)'::regprocedure))>0,
  'the periodic account page has a hard 50-account cap');
select has_table('public','progression_perfect_day_worker_cursor','fair account rotation has durable cursor state');
select has_table('public','progression_perfect_day_worker_failures','isolated worker failures are observable');
select ok(not has_table_privilege('authenticated','public.progression_perfect_day_worker_failures','select'),
  'failure diagnostics are not exposed to authenticated users');
select ok(position('pg_try_advisory_xact_lock' in pg_get_functiondef('public.reconcile_current_perfect_days(integer)'::regprocedure))>0,
  'overlapping scheduled runs exit without starting concurrent reconciliation');
select ok(position('when others then' in pg_get_functiondef('public.reconcile_current_perfect_days(integer)'::regprocedure))>0,
  'a single account failure is isolated and recorded');
select ok(position('s.user_id > coalesce(v_last_user_id' in pg_get_functiondef('public.reconcile_current_perfect_days(integer)'::regprocedure))>0,
  'worker uses indexed UUID keyset pages so failures cannot starve later accounts');
select ok(has_function_privilege('authenticated','public.refresh_my_progression_qualification_progress()','execute'),
  'the existing authenticated refresh RPC remains callable');
select ok(position('auth.uid()' in pg_get_functiondef('public.refresh_my_progression_qualification_progress()'::regprocedure))>0,
  'refresh remains bound to the authenticated owner');
select ok(position('reconcile_progression_achievements(' in pg_get_functiondef('public.refresh_my_progression_qualification_progress()'::regprocedure))=0
  and position('initialize_progression_account(' in pg_get_functiondef('public.refresh_my_progression_qualification_progress()'::regprocedure))=0,
  'refresh reports persisted achievement state without invoking history-sized reconciliation');
select ok(position('reconcile_missing_perfect_days' in pg_get_functiondef('public.refresh_my_progression_qualification_progress()'::regprocedure))=0,
  'authenticated refresh no longer performs a historical date scan');
select ok(position('progression_evaluate_perfect_day' in pg_get_functiondef('public.reconcile_perfect_day_repair_batch(integer)'::regprocedure))>0,
  'the bounded background queue still uses the canonical Perfect Day evaluator');
select ok(position('greatest(1, least(coalesce(p_limit, 50), 100))' in pg_get_functiondef('public.reconcile_perfect_day_repair_batch(integer)'::regprocedure))>0,
  'historical date reconciliation has a strict batch cap');

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000009101','calendar-refresh-owner@example.test'),
 ('00000000-0000-4000-8000-000000009102','calendar-refresh-isolation@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured) values
 ('general','00000000-0000-4000-8000-000000009101','UTC',true),
 ('general','00000000-0000-4000-8000-000000009102','UTC',true);
insert into public.progression_account_state(user_id,initialized_at,scoring_version,legacy_xp_kind)
values ('00000000-0000-4000-8000-000000009101','2026-10-01T00:00:00Z',2,'unavailable'),
       ('00000000-0000-4000-8000-000000009102','2026-10-01T00:00:00Z',2,'unavailable')
on conflict(user_id) do update set initialized_at=excluded.initialized_at,scoring_version=2,legacy_xp_kind='unavailable';
update public.progression_achievement_accounts set initialized_at='2026-10-01T00:00:00Z'
where user_id in ('00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009102');
update public.progression_policy_cutovers
set perfect_week_start=date_trunc('week',current_date::timestamp)::date,
    perfect_month_start=date_trunc('month',current_date::timestamp)::date,
    perfect_year_start=(date_trunc('year',current_date::timestamp)+interval '1 year')::date
where id;

-- Two legacy trackers exercise the conservative definition boundary; the v10
-- tracker exercises date-effective rule resolution in the same Perfect Day.
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
values
 ('00000000-0000-4000-8000-000000009111','00000000-0000-4000-8000-000000009101',1,'habit','active','Legacy A',
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000009111','kind','habit','status','active','name','Legacy A',
    'createdAt','2026-10-01T00:00:00Z','startDate','2026-10-01','schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  '2026-10-01T00:00:00Z','2026-10-30T00:00:00Z'),
 ('00000000-0000-4000-8000-000000009112','00000000-0000-4000-8000-000000009101',1,'habit','active','Legacy B',
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000009112','kind','habit','status','active','name','Legacy B',
    'createdAt','2026-10-01T00:00:00Z','startDate','2026-10-01','schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  '2026-10-01T00:00:00Z','2026-10-30T00:00:00Z'),
 ('00000000-0000-4000-8000-000000009113','00000000-0000-4000-8000-000000009101',10,'habit','active','Versioned C',
  jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000009113','kind','habit','status','active','name','Versioned C',
    'createdAt','2026-10-01T00:00:00Z','startDate','2026-10-01','schedule',jsonb_build_object('kind','every-day'),
    'scheduling',jsonb_build_object('mode','ongoing'),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'deadline',null,'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
    'streakRuleMode','same-as-success','strictMode',false,'customFields','[]'::jsonb,'milestones','[]'::jsonb,
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','baseline','effectiveFrom','2026-10-01','revision',1,'application','baseline',
      'recordedAt','2026-10-01T00:00:00Z','evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),
        'scheduling',jsonb_build_object('mode','ongoing'),'startDate','2026-10-01','deadline',null,
        'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
        'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
        'streakRuleMode','same-as-success','streakRule',null,'strictMode',false)))),
  '2026-10-01T00:00:00Z','2026-10-30T00:00:00Z');

-- A second owner has a qualifying record, but the first owner's refresh must
-- never reconcile or award it.
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
values ('00000000-0000-4000-8000-000000009121','00000000-0000-4000-8000-000000009102',1,'habit','active','Other account',
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000009121','kind','habit','status','active','name','Other account',
    'createdAt','2026-10-01T00:00:00Z','startDate','2026-10-01','schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  '2026-10-01T00:00:00Z','2026-10-30T00:00:00Z');

select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000009101','2026-10-31'),'failed'::text,
  'the October 31 fixture begins without required check-ins');

-- Reproduce the saved-history condition: all three check-ins and their ordinary
-- XP already exist, but no Perfect Day reconciliation was persisted.
set constraints all immediate;
alter table public.tracker_entries disable trigger tracker_entries_progression_award;
alter table public.tracker_entries disable trigger z_progression_achievement_entry_change;
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,note,created_at,updated_at)
values
 ('00000000-0000-4000-8000-000000009131','00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009111','2026-10-31','recorded','{"done":true}','october day one','2026-10-31T10:45:00Z','2026-10-31T10:45:00Z'),
 ('00000000-0000-4000-8000-000000009132','00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009112','2026-10-31','recorded','{"done":true}','october day two','2026-10-31T11:45:00Z','2026-10-31T11:45:00Z'),
 ('00000000-0000-4000-8000-000000009133','00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009113','2026-10-31','recorded','{"done":true}','october day three','2026-10-31T12:45:00Z','2026-10-31T12:45:00Z'),
 ('00000000-0000-4000-8000-000000009141','00000000-0000-4000-8000-000000009102','00000000-0000-4000-8000-000000009121','2026-10-31','recorded','{"done":true}','other owner','2026-10-31T12:45:00Z','2026-10-31T12:45:00Z');
alter table public.tracker_entries enable trigger tracker_entries_progression_award;
alter table public.tracker_entries enable trigger z_progression_achievement_entry_change;

select public.record_progression_entry_award('00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009111','00000000-0000-4000-8000-000000009131','2026-10-31','{"done":true}','recorded',null);
select public.record_progression_entry_award('00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009112','00000000-0000-4000-8000-000000009132','2026-10-31','{"done":true}','recorded',null);
select public.record_progression_entry_award('00000000-0000-4000-8000-000000009101','00000000-0000-4000-8000-000000009113','00000000-0000-4000-8000-000000009133','2026-10-31','{"done":true}','recorded',null);

select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000009101','2026-10-31'),'perfect'::text,
  'October 31 qualifies across legacy and v10 date-effective definitions');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='DAILY_CHECK_IN_COMPLETED' and effective_date='2026-10-31'),3::bigint,
  'ordinary check-in XP exists before Perfect Day recovery');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-31'),0::bigint,
  'the reproduced October 31 gap has no fabricated Perfect Day award');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000009101';
select lives_ok($$select public.refresh_my_progression_qualification_progress()$$,
  'authenticated refresh returns without running historical repair');
reset role;

select is((select count(*)::integer from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009101' and entry_date='2026-10-31'),1,
  'the missed October 31 date remains durably queued after page refresh');
select is((select count(*)::integer from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-31'),0,
  'page refresh does not block on or prematurely claim queued history');
select is((select count(*)::integer from public.progression_events where user_id='00000000-0000-4000-8000-000000009102'
  and reason_code='PERFECT_DAY_BONUS'),0,
  'refresh does not reconcile another owner while that owner has independent queued work');
select lives_ok($$select public.reconcile_perfect_day_repair_batch(50)$$,
  'scheduled bounded worker repairs missing historical Perfect Days without page refresh');

select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-31' and xp_delta=20),1::bigint,
  'October 31 produces exactly one canonical 20 XP Perfect Day award');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000009101'
  and award_key=md5('00000000-0000-4000-8000-000000009101:perfect-day:2026-10-31')::uuid),20,
  'the append-only award state records the canonical generation');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000009101'
  and achievement_id='perfect-day' and event_type='unlocked'),1::bigint,
  'the supported post-cutover October 31 repair unlocks its Perfect Day achievement');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='DAILY_CHECK_IN_COMPLETED' and effective_date='2026-10-31'),3::bigint,
  'Perfect Day recovery leaves ordinary check-in awards unchanged');
select is((select count(*) from public.tracker_entries where user_id='00000000-0000-4000-8000-000000009101'
  and entry_date='2026-10-31' and outcome='recorded' and entry_values='{"done":true}'::jsonb
  and note in ('october day one','october day two','october day three')),3::bigint,
  'reconciliation preserves all October 31 check-in dates, raw values, and notes');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000009101';
select lives_ok($$select public.refresh_my_progression_qualification_progress()$$,
  'repeated refresh is safe');
reset role;
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-31'),1::bigint,
  'repeated refresh does not duplicate the Perfect Day XP event');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000009101'
  and achievement_id='perfect-day' and event_type='unlocked'),1::bigint,
  'repeated refresh preserves exactly one Perfect Day achievement occurrence');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009102'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-31'),1::bigint,
  'global worker independently repairs the second owner’s own qualifying date');

-- The saved date is resolved in the owner's timezone, which can differ from
-- the UTC date. The worker repairs it without an achievements-page refresh.
update public.app_settings set timezone='Pacific/Kiritimati',timezone_configured=true
where user_id='00000000-0000-4000-8000-000000009102';
set constraints all immediate;
alter table public.tracker_entries disable trigger tracker_entries_progression_award;
alter table public.tracker_entries disable trigger z_progression_achievement_entry_change;
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,note,created_at,updated_at)
values ('00000000-0000-4000-8000-000000009142','00000000-0000-4000-8000-000000009102','00000000-0000-4000-8000-000000009121',
  (clock_timestamp() at time zone 'Pacific/Kiritimati')::date,'recorded','{"done":true}','worker recovers current day',clock_timestamp(),clock_timestamp());
alter table public.tracker_entries enable trigger tracker_entries_progression_award;
alter table public.tracker_entries enable trigger z_progression_achievement_entry_change;
select public.record_progression_entry_award('00000000-0000-4000-8000-000000009102','00000000-0000-4000-8000-000000009121',
  '00000000-0000-4000-8000-000000009142',(clock_timestamp() at time zone 'Pacific/Kiritimati')::date,'{"done":true}','recorded',null);
select is(public.reconcile_current_perfect_days(500),1,
  'bounded worker recovers a qualifying current-date check-in without an achievements-page refresh');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009102'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=(clock_timestamp() at time zone 'Pacific/Kiritimati')::date and xp_delta=20),1::bigint,
  'scheduled recovery writes the canonical Perfect Day ledger event for its owner');
select is(public.reconcile_current_perfect_days(500),0,
  'repeated scheduled recovery skips already active award state');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009102'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=(clock_timestamp() at time zone 'Pacific/Kiritimati')::date),1::bigint,
  'repeated scheduled recovery does not duplicate the award event');
select is((select count(*) from cron.job where jobname='progress-tracker-current-perfect-days'
  and schedule='*/5 * * * *' and active),1::bigint,
  'future-date reconciliation is installed as an active five-minute local-date worker');

select is((select qualification_details->>'status' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000009101' and achievement_id='perfect-week'),'in_progress'::text,
  'the configured current week is available and remains in progress');
select is((select (qualification_details->>'target')::integer from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000009101' and achievement_id='perfect-month'),
  extract(day from (date_trunc('month',current_date::timestamp)+interval '1 month'-interval '1 day'))::integer,
  'refresh publishes the actual current month target instead of the stale repeatable-badge target');
select is((select qualification_details->>'status' from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000009101' and achievement_id='perfect-year'),'unavailable'::text,
  'a year before the strict year policy is unavailable rather than zero progress');
select is((select (qualification_details->>'target')::integer from public.progression_achievement_progress
  where user_id='00000000-0000-4000-8000-000000009101' and achievement_id='perfect-year'),
  case when extract(year from current_date)::integer % 4=0 and (extract(year from current_date)::integer % 100<>0 or extract(year from current_date)::integer % 400=0) then 366 else 365 end,
  'current-year details use the correct 365 or 366 day target');
select ok(position('progression_policy_cutovers' in pg_get_functiondef('public.refresh_progression_perfect_period_details(uuid)'::regprocedure))>0,
  'current-period details enforce the configured week, month, and year policy cutovers');
select ok(position('v_status := ''earned''' in pg_get_functiondef('public.refresh_progression_perfect_period_details(uuid)'::regprocedure))>0,
  'a fully confirmed completed calendar period is explicitly reported as earned');

select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009101'
  and reason_code='PERFECT_DAY_BONUS' and effective_date='2026-10-29'),0::bigint,
  'unsupported pre-boundary history is not awarded during recovery');

select * from finish();
rollback;
