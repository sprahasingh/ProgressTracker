begin;
select plan(44);

select has_table('public','progression_achievement_progress','server-derived achievement progress exists');
select has_table('public','progression_achievement_events','append-only achievement history exists');
select is((select relrowsecurity from pg_class where oid='public.progression_achievement_events'::regclass),true,'achievement history has RLS enabled');
select ok(has_table_privilege('authenticated','public.progression_achievement_events','select'),'authenticated users can read achievement history through owner RLS');
select ok(not has_table_privilege('authenticated','public.progression_achievement_events','insert'),'clients cannot forge achievement unlocks');
select ok(not has_table_privilege('authenticated','public.progression_achievement_progress','update'),'clients cannot change achievement progress');
select ok(position('v_record.achievement_id=''consistency-star'' and v_consistency_days < 30' in pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure)) > 0,'Consistency Star requires the full 30 eligible-day window');
select ok(position('eligible_days_target' in pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure)) > 0,'Consistency Star publishes server-computed qualification details');

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000401','progression-achievements@example.test'),
 ('00000000-0000-4000-8000-000000000402','progression-achievements-other@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured) values
 ('general','00000000-0000-4000-8000-000000000401','UTC',true),
 ('general','00000000-0000-4000-8000-000000000402','UTC',true);

select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401'),0::bigint,'legacy opening XP does not fabricate achievement unlocks');
select is((select count(*) from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step'),1::bigint,'new account receives a locked progress record for each achievement');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000401';
select is((select count(*) from public.progression_achievement_progress),14::bigint,'owner sees all current achievement progress');
select is((select count(*) from public.progression_achievement_events),0::bigint,'owner initially has no earned achievements');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000401';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000410','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000411','schema_version',1,'kind','habit','status','active','name','private tracker name',
   'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000411','kind','habit','status','active','createdAt',current_date::text||'T00:00:00Z',
     'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))
))->>'status','applied'::text,'tracker is accepted');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000412','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000413','tracker_id','00000000-0000-4000-8000-000000000411','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','private note','created_at',clock_timestamp())
))->>'status','applied'::text,'qualifying saved check-in is accepted');
reset role;

select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step' and event_type='unlocked'),1::bigint,'first-step unlock is recorded once');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='perfect-day' and event_type='unlocked'),1::bigint,'Perfect Day unlock is server-confirmed');
select is((select (qualification_details->>'eligible_days')::integer from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='consistency-star'),0,'Consistency Star reports no completed eligible days for a fresh same-day check-in');
select is((select (qualification_details->>'eligible_days_target')::integer from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='consistency-star'),30,'Consistency Star publishes its 30-day window target');
select is((select qualification_details->>'adherence_percent' from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='consistency-star'),null::text,'Consistency Star does not invent an adherence score before a completed eligible day');
select is((select (qualification_details->>'adherence_target_percent')::numeric from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='consistency-star'),80::numeric,'Consistency Star publishes its 80 percent adherence target');
select is((select repeatable from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='perfect-day'),true,'Perfect Day cadence is repeatable');
select is((select repeatable from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='milestone-maker'),true,'Milestone Maker cadence is repeatable');
select is((select repeatable from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='goal-crusher'),true,'Goal Crusher cadence is repeatable');
select ok((select source_event_id is not null and source_date=current_date from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step' and event_type='unlocked'),'unlock retains its authoritative event and date reference');
select ok(not exists(select 1 from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and source_reference::text like '%private tracker name%' or source_reference::text like '%private note%'),'achievement sources do not retain tracker names or notes');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000402';
select is((select count(*) from public.progression_achievement_events),0::bigint,'other account cannot read earned achievements');
select is((select count(*) from public.progression_achievement_progress),14::bigint,'other account sees only its own locked progress');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000401';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000414','tracker_entry',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000413','tracker_id','00000000-0000-4000-8000-000000000411','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('done',false),'note','','created_at',clock_timestamp())
))->>'status','applied'::text,'accepted historical correction is applied');
reset role;
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step' and event_type='revoked'),1::bigint,'correction revokes achievement without deleting unlock history');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='perfect-day' and event_type='revoked'),1::bigint,'correction revokes Perfect Day without deleting history');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000401';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000415','tracker_entry',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000413','tracker_id','00000000-0000-4000-8000-000000000411','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','','created_at',clock_timestamp())
))->>'status','applied'::text,'requalified check-in is accepted');
reset role;
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step' and event_type='unlocked'),2::bigint,'requalification creates a new generation rather than duplicating an active unlock');
select is((select count(distinct occurrence_key) from public.progression_achievement_occurrences where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='perfect-day'),1::bigint,'Perfect Day reversal and requalification retain one distinct day occurrence');

select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000401');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='first-step' and event_type='unlocked'),2::bigint,'repeated reconciliation does not duplicate unlock events');

with generated as (
  select day_index, md5('progression-achievement-dedicated:'||day_index::text)::uuid as event_id,
    md5('progression-achievement-dedicated-key:'||day_index::text)::uuid as award_key
  from generate_series(1,200) day_index
), inserted as (
  insert into public.progression_events(id,user_id,event_category,reason_code,effective_date,recorded_at,xp_delta,scoring_version,idempotency_key)
  select event_id,'00000000-0000-4000-8000-000000000401','check_in','DAILY_CHECK_IN_COMPLETED',current_date,
    clock_timestamp()+day_index*interval '1 microsecond',10,2,md5('progression-achievement-dedicated:'||day_index::text)::uuid
  from generated returning id,idempotency_key
)
insert into public.progression_award_state(user_id,award_key,reason_code,effective_date,current_xp,current_event_id,generation)
select '00000000-0000-4000-8000-000000000401',generated.award_key,'DAILY_CHECK_IN_COMPLETED',current_date,10,inserted.id,1
from generated join inserted on inserted.id=generated.event_id;

select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000401');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='dedicated'),1,'Dedicated progress stores one-time unlocked state');
select is((select repeatable from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='dedicated'),false,'Dedicated is classified as one-time by the server');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='dedicated' and event_type='unlocked'),1::bigint,'Dedicated creates only its initial one-time unlock');
select is((select count(distinct source_event_id) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='dedicated' and event_type='unlocked'),1::bigint,'Dedicated points to only its first 100-check-in crossing event');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000401');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401' and achievement_id='dedicated' and event_type='unlocked'),1::bigint,'retrying reconciliation does not duplicate the one-time Dedicated award');

delete from auth.users where id='00000000-0000-4000-8000-000000000401';
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000411'),0::bigint,'account deletion cascade bypasses the tracker XP guard and removes tracker data');
select is((select count(*) from public.tracker_entries where id='00000000-0000-4000-8000-000000000413'),0::bigint,'account deletion cascade removes tracker entry data despite progression history');
select is((select count(*) from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000401'),0::bigint,'account deletion cascades achievement progress');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000401'),0::bigint,'account deletion cascades achievement event history');
select is((select count(*) from public.progression_achievement_accounts where user_id='00000000-0000-4000-8000-000000000401'),0::bigint,'account deletion cascades achievement cutover state');

select * from finish();
rollback;
