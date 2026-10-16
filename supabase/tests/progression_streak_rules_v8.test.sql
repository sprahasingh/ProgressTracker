begin;
set local statement_timeout = '60s';
select plan(26);

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000931','streak-rules-v8@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000000931','UTC',true)
on conflict(user_id) do update set timezone='UTC',timezone_configured=true;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000931';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000000933','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000932','schema_version',8,'kind','habit','status','active','name','Historical custom streak',
  'created_at',clock_timestamp(),'definition',jsonb_build_object('schemaVersion',8,'id','00000000-0000-4000-8000-000000000932','kind','habit','status','active',
   'name','Historical custom streak','createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-15)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','precision',jsonb_build_object('decimalPlaces',0,'increment',1))),
   'schedule',jsonb_build_object('kind','every-day'),
   'qualificationRule',jsonb_build_object('kind','comparison','metricId','pages','operator','at-least','value',5),
   'streakRuleMode','custom','streakRule',jsonb_build_object('kind','comparison','metricId','pages','operator','equals','value',1)))
))->>'status','applied','schema v8 custom success and streak rules are accepted');

select ok(bool_and(result->>'status'='applied'),
 'fifteen historical streak-only entries are accepted after account cutover')
from (
 select public.apply_tracker_sync_operation(
   '00000000-0000-4000-8000-000000000931',
   ('00000000-0000-4000-8000-'||lpad((3000+i)::text,12,'0'))::uuid,
   'tracker_entry',null,
   jsonb_build_object(
     'id',('00000000-0000-4000-8000-'||lpad((2000+i)::text,12,'0'))::uuid,
     'tracker_id','00000000-0000-4000-8000-000000000932',
     'entry_date',(current_date-15+i)::text,
     'outcome','recorded','entry_values',jsonb_build_object('pages',1),'created_at',clock_timestamp()
   )) as result
 from generate_series(0,14) as days(i)
) entries;
reset role;

select ok(public.progression_date_is_eligible(
 '00000000-0000-4000-8000-000000000931',
 (select t from public.trackers t where t.id='00000000-0000-4000-8000-000000000932'),
 current_date-1), 'configured UTC schedule eligibility remains true');
set local session_replication_role = replica;
update public.app_settings set timezone='Not/AZone' where user_id='00000000-0000-4000-8000-000000000931';
select is(public.progression_date_is_eligible(
 '00000000-0000-4000-8000-000000000931',
 (select t from public.trackers t where t.id='00000000-0000-4000-8000-000000000932'),
 current_date-1), false, 'an invalid configured timezone remains ineligible');
update public.app_settings set timezone='UTC' where user_id='00000000-0000-4000-8000-000000000931';
set local session_replication_role = origin;

select is(coalesce((select sum(current_xp) from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='DAILY_CHECK_IN_COMPLETED'),0),0::bigint,
 'streak-only backfilled days earn no normal daily success XP');
select is(coalesce((select sum(current_xp) from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='STREAK_MILESTONE'),0),85::bigint,
 'historical streak-only days award the existing seven and fourteen day milestone amounts');
select is((select count(*)::integer from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='STREAK_MILESTONE' and current_xp>0),2,
 'each eligible historical streak milestone has one active reward identity');
select is((select current_tier from public.progression_achievement_progress
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='first-step'),0,
 'streak-only activity does not unlock the success-based First Step achievement');
select is((select current_tier from public.progression_achievement_progress
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='steady-flame'),1,
 'historical Streak Rule qualification unlocks the fourteen-day streak achievement');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000004001','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000002001','tracker_id','00000000-0000-4000-8000-000000000932',
  'entry_date',(current_date-14)::text,'outcome','recorded','entry_values',jsonb_build_object('pages',5)))
)->>'status','applied','an existing historical entry can be edited independently of its streak result');
reset role;
select is((select current_xp from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and source_id='00000000-0000-4000-8000-000000002001'
   and reason_code='DAILY_CHECK_IN_COMPLETED'),10,
 'a success-only historical day earns normal daily success XP');
select is((select current_xp from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931'
   and award_key=md5('00000000-0000-4000-8000-000000000931:streak:00000000-0000-4000-8000-000000000932:14')::uuid),0,
 'a success-only day does not preserve the fourteen-day streak milestone');
select is(coalesce((select sum(current_xp) from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='STREAK_MILESTONE'),0),35::bigint,
 'only the still-qualified seven-day streak milestone remains active');
select ok(exists(
 select 1 from public.progression_events reversal
 join public.progression_event_sources source on source.user_id=reversal.user_id and source.event_id=reversal.id
 where reversal.user_id='00000000-0000-4000-8000-000000000931'
   and reversal.reason_code='AWARD_REVERSAL' and reversal.xp_delta=-50
   and source.tracker_id='00000000-0000-4000-8000-000000000932'
), 'reversed streak XP remains attributed to its tracker');
select is((select current_tier from public.progression_achievement_progress
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='first-step'),1,
 'the same success-only day can unlock a success-based achievement');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000004002','tracker_entry',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000002001','tracker_id','00000000-0000-4000-8000-000000000932',
  'entry_date',(current_date-14)::text,'outcome','recorded','entry_values',jsonb_build_object('pages',0)))
)->>'status','applied','historical entries that meet neither rule remain editable');
reset role;
select is((select current_xp from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and source_id='00000000-0000-4000-8000-000000002001'
   and reason_code='DAILY_CHECK_IN_COMPLETED'),0,
 'editing a historical success to a neither-rule value reverses its daily XP');
select is((select current_tier from public.progression_achievement_progress
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='first-step'),0,
 'the success achievement is revoked after its only qualifying source is corrected');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000004003','tracker_entry',3,
 jsonb_build_object('id','00000000-0000-4000-8000-000000002001','tracker_id','00000000-0000-4000-8000-000000000932',
  'entry_date',(current_date-14)::text,'outcome','recorded','entry_values',jsonb_build_object('pages',1)))
)->>'status','applied','restoring a historical streak-only result is accepted');
reset role;
select is(coalesce((select sum(current_xp) from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='DAILY_CHECK_IN_COMPLETED'),0),0::bigint,
 'restoring streak-only qualification does not restore success XP');
select is((select current_xp from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931'
   and award_key=md5('00000000-0000-4000-8000-000000000931:streak:00000000-0000-4000-8000-000000000932:14')::uuid),50,
 'restoring streak qualification reactivates the same fourteen-day milestone identity');
select is((select current_tier from public.progression_achievement_progress
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='steady-flame'),1,
 'restoring historical streak qualification reactivates the streak achievement');
select is((select count(*)::integer from public.progression_achievement_events
 where user_id='00000000-0000-4000-8000-000000000931' and achievement_id='steady-flame' and event_type='unlocked'),2,
 'streak achievement requalification appends one auditable generation');

select public.reconcile_progression_tracker_milestones('00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000000932');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000931');
select public.reconcile_progression_tracker_milestones('00000000-0000-4000-8000-000000000931','00000000-0000-4000-8000-000000000932');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000931');
select is((select current_xp from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000931'
   and award_key=md5('00000000-0000-4000-8000-000000000931:streak:00000000-0000-4000-8000-000000000932:14')::uuid),50,
 'repeated historical reconciliation leaves one active fourteen-day milestone credit');
select is((select count(*)::integer from public.progression_events
 where user_id='00000000-0000-4000-8000-000000000931' and reason_code='DAILY_CHECK_IN_COMPLETED'),1,
 'repeated reconciliation does not duplicate daily XP awards');
select is((select count(*)::integer from public.progression_achievement_events u
 where u.user_id='00000000-0000-4000-8000-000000000931' and u.achievement_id='steady-flame'
   and u.event_type='unlocked'
   and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),1,
 'repeated reconciliation leaves one active streak achievement occurrence');

select * from finish();
rollback;
