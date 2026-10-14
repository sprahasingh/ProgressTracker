begin;
select plan(12);
set local timezone = 'Asia/Kolkata';

insert into auth.users (id,email) values ('00000000-0000-4000-8000-000000000089','perfect-day-rule-mismatch@example.test');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000089';
insert into public.app_settings (id,user_id,timezone,timezone_configured)
values ('general','00000000-0000-4000-8000-000000000089','UTC',false);

-- These three trackers succeed in the Today summary at their configured
-- minimum (5), while their separate streak qualification threshold is target
-- (10). Entries of 5 therefore reproduce a 3/3 Today / locked Perfect Day.
select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000891','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000890','schema_version',1,'kind','habit','status','active','name','Routine one',
    'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000890','kind','habit','status','active',
      'createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('minimum',5,'target',10,'direction','increase','streakQualification','target'))),'schedule',jsonb_build_object('kind','every-day')))
))->>'status';
select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000892','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000893','tracker_id','00000000-0000-4000-8000-000000000890','entry_date',current_date::text,
    'outcome','recorded','entry_values',jsonb_build_object('amount',5),'created_at',clock_timestamp())
))->>'status';

select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000894','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000895','schema_version',1,'kind','habit','status','active','name','Routine two',
    'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000895','kind','habit','status','active',
      'createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('minimum',5,'target',10,'direction','increase','streakQualification','target'))),'schedule',jsonb_build_object('kind','every-day')))
))->>'status';
select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000896','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000897','tracker_id','00000000-0000-4000-8000-000000000895','entry_date',current_date::text,
    'outcome','recorded','entry_values',jsonb_build_object('amount',5),'created_at',clock_timestamp())
))->>'status';

select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000898','tracker',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000899','schema_version',1,'kind','habit','status','active','name','Routine three',
    'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000899','kind','habit','status','active',
      'createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('minimum',5,'target',10,'direction','increase','streakQualification','target'))),'schedule',jsonb_build_object('kind','every-day')))
))->>'status';
select (public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000089','00000000-0000-4000-8000-000000000900','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000901','tracker_id','00000000-0000-4000-8000-000000000899','entry_date',current_date::text,
    'outcome','recorded','entry_values',jsonb_build_object('amount',5),'created_at',clock_timestamp())
))->>'status';

reset role;
select is(coalesce((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),0),
  0,'an unconfigured UTC default cannot silently award using the wrong account date');
-- At 00:30 IST on Oct 15, the instant is still Oct 14 in UTC. The date helper
-- used by Perfect Day must preserve the account-local calendar date.
select is(public.progression_local_date('2026-10-14 19:00:00+00'::timestamptz,'Asia/Kolkata'),
  '2026-10-15'::date,'12:30 AM IST remains Oct 15 while UTC is Oct 14');
-- The check-ins above were saved while the database default UTC had not been
-- marked as an intentional account timezone. Changing to the configured IANA
-- timezone backfills their retained date and awards the missed occurrence.
update public.app_settings set timezone='Asia/Kolkata',timezone_configured=true
where user_id='00000000-0000-4000-8000-000000000089';
select is((select count(*)::integer from public.tracker_entries e join public.trackers t on t.id=e.tracker_id
  where e.user_id='00000000-0000-4000-8000-000000000089' and e.entry_date=current_date and e.outcome='recorded'
    and (e.entry_values->>'amount')::numeric >= (t.definition->'metrics'->0->'thresholds'->>'minimum')::numeric),
  3,'all three entries meet the frontend minimum success threshold');
select is(public.progression_evaluate_account_day('00000000-0000-4000-8000-000000000089',current_date),
  'pending'::text,'the existing streak-based account-day evaluator remains unchanged');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  20,'Perfect Day immediately awards twenty XP at the configured minimum success threshold');

update public.tracker_entries set entry_values=jsonb_build_object('amount',4)
where user_id='00000000-0000-4000-8000-000000000089' and id='00000000-0000-4000-8000-000000000893';
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  0,'correcting one entry below the minimum reverses the Perfect Day bonus');

update public.tracker_entries set entry_values=jsonb_build_object('amount',5)
where user_id='00000000-0000-4000-8000-000000000089' and id='00000000-0000-4000-8000-000000000893';
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  20,'requalification at the exact minimum threshold restores the bonus');

update public.tracker_entries set entry_values=jsonb_build_object('amount',10)
where user_id='00000000-0000-4000-8000-000000000089' and id='00000000-0000-4000-8000-000000000893';
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  20,'meeting the exact target threshold retains the Perfect Day award');
update public.tracker_entries set entry_values=jsonb_build_object('amount',11)
where user_id='00000000-0000-4000-8000-000000000089' and id='00000000-0000-4000-8000-000000000893';
select public.reconcile_progression_perfect_day('00000000-0000-4000-8000-000000000089',current_date);
select public.reconcile_progression_perfect_day('00000000-0000-4000-8000-000000000089',current_date);
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  20,'an above-target entry retains exactly one active Perfect Day award');
select is((select count(*)::integer from public.progression_events where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'),
  2,'one qualification and one requalification create exactly two award generations despite repeated reconciliation');
select is((select count(*)::integer from public.progression_events reversal
  where reversal.user_id='00000000-0000-4000-8000-000000000089' and reversal.reason_code='AWARD_REVERSAL'
    and reversal.reverses_event_id in (select id from public.progression_events award where award.user_id=reversal.user_id and award.reason_code='PERFECT_DAY_BONUS')),
  1,'the single loss of qualification reverses exactly one Perfect Day generation');
select is((select sum(xp_delta)::integer from public.progression_events where user_id='00000000-0000-4000-8000-000000000089' and (reason_code='PERFECT_DAY_BONUS' or reverses_event_id in (select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000089' and reason_code='PERFECT_DAY_BONUS'))),
  20,'the qualifying occurrence nets exactly twenty XP across its award and reversal history');

select * from finish();
rollback;
