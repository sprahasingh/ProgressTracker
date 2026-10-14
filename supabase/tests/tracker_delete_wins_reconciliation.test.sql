begin;
select plan(45);

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000701','delete-wins-shared@example.test'),
 ('00000000-0000-4000-8000-000000000702','delete-wins-revoke@example.test'),
 ('00000000-0000-4000-8000-000000000703','delete-wins-legacy@example.test'),
 ('00000000-0000-4000-8000-000000000704','delete-wins-rollback@example.test');

-- Two independently completed trackers earn check-in XP, First Step, and a
-- shared Perfect Day. Deleting one must reverse only its own check-in XP.
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000701';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000711','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000721','schema_version',1,'kind','habit','status','active','name','target private name',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000721','kind','habit','status','active','createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','target tracker fixture created');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000712','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000722','schema_version',1,'kind','habit','status','active','name','unrelated tracker',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000722','kind','habit','status','active','createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','independent tracker fixture created');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000731','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000741','tracker_id','00000000-0000-4000-8000-000000000721','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true)) ))->>'status','applied','target check-in fixture accepted');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000732','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000742','tracker_id','00000000-0000-4000-8000-000000000722','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true)) ))->>'status','applied','independent check-in fixture accepted');
reset role;

select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000701' and achievement_id='first-step' and event_type='unlocked'),1::bigint,'First Step earned before deletion');
select is((select count(*) from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and reason_code='PERFECT_DAY_BONUS' and current_xp>0),1::bigint,'shared Perfect Day award earned before deletion');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000701',md5('00000000-0000-4000-8000-000000000701:streak:00000000-0000-4000-8000-000000000721:7')::uuid,'STREAK_MILESTONE',current_date,35,'00000000-0000-4000-8000-000000000721',null,md5('00000000-0000-4000-8000-000000000701:streak:00000000-0000-4000-8000-000000000721:7')::uuid,true,'fixture streak');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000701',md5('delete-wins-target-goal')::uuid,'GOAL_MILESTONE',current_date,25,'00000000-0000-4000-8000-000000000721',null,null,true,'fixture goal');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000701',md5('delete-wins-target-completed')::uuid,'GOAL_COMPLETED',current_date,100,'00000000-0000-4000-8000-000000000721',null,null,true,'fixture completion');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000701',md5('delete-wins-unrelated-streak')::uuid,'STREAK_MILESTONE',current_date,35,'00000000-0000-4000-8000-000000000722',null,md5('delete-wins-unrelated-streak')::uuid,true,'unrelated fixture streak');
select is((select count(*) from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and tracker_id='00000000-0000-4000-8000-000000000721' and reason_code in ('STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED') and current_xp>0),3::bigint,'target tracker has attributable streak and goal rewards');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and award_key=md5('delete-wins-unrelated-streak')::uuid and reason_code='STREAK_MILESTONE'),35,'independent tracker milestone is recorded');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000751','tracker',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000721','schema_version',1,'kind','habit','status','active','name','target private name','deleted_at',clock_timestamp(),'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000721','kind','habit','status','active','deletedAt',clock_timestamp(),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','target tracker moves to Bin');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000701';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000761','00000000-0000-4000-8000-000000000721',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000721'),'delete_wins')->>'status'),'deleted','Delete Wins succeeds after First Step when account awards are attributable');
select is((select count(*) from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000701'),0::bigint,'Delete Wins creates no retained tracker-name or reward-context snapshots');
reset role;
select is((select sum(event.xp_delta) from public.progression_events event
 where event.user_id='00000000-0000-4000-8000-000000000701'
   and (event.id=(select id from public.progression_events where user_id=event.user_id and idempotency_key=md5('00000000-0000-4000-8000-000000000701:00000000-0000-4000-8000-000000000741:daily-check-in-v1')::uuid)
     or event.reverses_event_id=(select id from public.progression_events where user_id=event.user_id and idempotency_key=md5('00000000-0000-4000-8000-000000000701:00000000-0000-4000-8000-000000000741:daily-check-in-v1')::uuid))),0::bigint,'target check-in award and its reversal net to zero');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and source_id='00000000-0000-4000-8000-000000000742'),10,'unrelated tracker reward remains active');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and reason_code='PERFECT_DAY_BONUS'),20,'shared Perfect Day remains while the remaining eligible tracker qualifies');
select ok((select count(*)=3 from public.progression_award_state
 where user_id='00000000-0000-4000-8000-000000000701'
   and (award_key,reason_code) in (
     (md5('00000000-0000-4000-8000-000000000701:streak:00000000-0000-4000-8000-000000000721:7')::uuid,'STREAK_MILESTONE'),
     (md5('delete-wins-target-goal')::uuid,'GOAL_MILESTONE'),
     (md5('delete-wins-target-completed')::uuid,'GOAL_COMPLETED'))
   and current_xp=0 and current_event_id is null and tracker_id is null and source_id is null),
 'each target streak/goal award is reversed and its tracker/source attribution is cleared');
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000701' and award_key=md5('delete-wins-unrelated-streak')::uuid and reason_code='STREAK_MILESTONE'),35,'unrelated tracker milestone survives');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000701' and achievement_id='first-step' and event_type='revoked'),0::bigint,'unrelated surviving activity keeps First Step earned');
select is((select count(*) from public.progression_event_sources where user_id='00000000-0000-4000-8000-000000000701' and tracker_id='00000000-0000-4000-8000-000000000721'),0::bigint,'deleted tracker source associations are removed');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000701' and reason_code='AWARD_REVERSAL'),4::bigint,'exactly four target award reversals exist before retry');
select is((with expected(key) as (values
   (md5('00000000-0000-4000-8000-000000000701:00000000-0000-4000-8000-000000000741:daily-check-in-v1')::uuid),
   (md5('progression:'||md5('00000000-0000-4000-8000-000000000701:streak:00000000-0000-4000-8000-000000000721:7')::uuid::text||':1')::uuid),
   (md5('progression:'||md5('delete-wins-target-goal')::uuid::text||':1')::uuid),
   (md5('progression:'||md5('delete-wins-target-completed')::uuid::text||':1')::uuid))
 select count(*) from expected
 join public.progression_events original on original.user_id='00000000-0000-4000-8000-000000000701' and original.idempotency_key=expected.key
 join public.progression_events reversal on reversal.user_id=original.user_id and reversal.reverses_event_id=original.id
 where reversal.reason_code='AWARD_REVERSAL' and reversal.xp_delta=-original.xp_delta),4::bigint,'each target reversal references its exact original award before retry');
set local role authenticated;
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000701','00000000-0000-4000-8000-000000000761','00000000-0000-4000-8000-000000000721',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000721'),'delete_wins')->>'status'),'already_deleted','retry returns the durable tombstone');
reset role;
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000701' and reason_code='AWARD_REVERSAL'),4::bigint,'exactly four reversals remain after retry');
select is((with expected(key) as (values
   (md5('00000000-0000-4000-8000-000000000701:00000000-0000-4000-8000-000000000741:daily-check-in-v1')::uuid),
   (md5('progression:'||md5('00000000-0000-4000-8000-000000000701:streak:00000000-0000-4000-8000-000000000721:7')::uuid::text||':1')::uuid),
   (md5('progression:'||md5('delete-wins-target-goal')::uuid::text||':1')::uuid),
   (md5('progression:'||md5('delete-wins-target-completed')::uuid::text||':1')::uuid))
 select count(*) from expected
 join public.progression_events original on original.user_id='00000000-0000-4000-8000-000000000701' and original.idempotency_key=expected.key
 join public.progression_events reversal on reversal.user_id=original.user_id and reversal.reverses_event_id=original.id
 where reversal.reason_code='AWARD_REVERSAL' and reversal.xp_delta=-original.xp_delta),4::bigint,'retry preserves exactly one correctly linked reversal for each target award');

-- A sole check-in unlock is revoked as an anonymized history event. Its
-- account/date Perfect Day is reversed because no eligible trackers remain.
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000702';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000771','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000772','schema_version',1,'kind','habit','status','active','name','sole tracker','created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000772','kind','habit','status','active','createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','sole tracker created');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000773','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000774','tracker_id','00000000-0000-4000-8000-000000000772','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true))))->>'status','applied','sole qualifying check-in accepted');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000775','tracker',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000772','schema_version',1,'kind','habit','status','active','name','sole tracker','deleted_at',clock_timestamp(),'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000772','kind','habit','status','active','deletedAt',clock_timestamp(),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','sole tracker moves to Bin');
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000776','00000000-0000-4000-8000-000000000772',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000772'),'delete_wins')->>'status'),'deleted','sole tracker Delete Wins succeeds');
reset role;
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000702' and achievement_id='first-step' and event_type='unlocked'),1::bigint,'historical First Step unlock remains recorded');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000702' and achievement_id='first-step' and event_type='revoked'),1::bigint,'First Step is revoked after its only qualifying source is deleted');
select ok(not exists (
  select 1 from public.progression_achievement_events achievement
  where achievement.user_id='00000000-0000-4000-8000-000000000702'
    and (
      achievement.source_reference::text like '%00000000-0000-4000-8000-000000000772%'
      or achievement.source_reference::text like '%00000000-0000-4000-8000-000000000774%'
      or achievement.source_reference::text like '%sole tracker%'
      or achievement.source_reference - 'rule' - 'reason' - 'source' - 'occurrence' <> '{}'::jsonb
      or (achievement.source_reference ? 'occurrence'
        and achievement.source_reference->>'occurrence' <> 'ledger-award')
      or (achievement.source_reference ? 'source'
        and achievement.source_reference <> '{"source":"tracker deletion"}'::jsonb)
      or (achievement.source_reference ? 'rule' and achievement.source_reference->>'rule' not in (
        'First qualifying saved check-in',
        'One server-confirmed Perfect Day after achievement cutover',
        'A distinct server-confirmed reward source qualified'))
      or (achievement.source_reference ? 'reason' and achievement.source_reference->>'reason' not in (
        'Eligibility no longer holds after an accepted historical correction',
        'The source reward was reversed'))
      or (achievement.source_event_id is not null and not exists (
        select 1 from public.progression_events source_event
        join public.progression_event_sources source on source.user_id=source_event.user_id and source.event_id=source_event.id
        where source_event.user_id=achievement.user_id and source_event.id=achievement.source_event_id
          and source_event.reason_code='PERFECT_DAY_BONUS' and source_event.event_category='daily_bonus'
          and source_event.metadata - 'award_generation' - 'rule' = '{}'::jsonb
          and source_event.metadata->>'award_generation'='1'
          and source_event.metadata->>'rule' in (
            'Every eligible tracker was completed for this date',
            'Every required tracker qualified on this date')
          and source.tracker_id is null and source.goal_id is null and source.source_id is null
          and source.display_name='Deleted tracker'
          and source_event.metadata::text not like '%00000000-0000-4000-8000-000000000772%'
          and source_event.metadata::text not like '%00000000-0000-4000-8000-000000000774%'
          and source_event.metadata::text not like '%sole tracker%'
          and source.display_name not like '%sole tracker%'
      ))
    )
) and not exists (
  select 1 from public.progression_event_sources source
  where source.user_id='00000000-0000-4000-8000-000000000702'
    and (source.tracker_id='00000000-0000-4000-8000-000000000772'
      or source.source_id='00000000-0000-4000-8000-000000000774'
      or source.display_name='sole tracker')
), 'retained achievement references contain only anonymized, non-identifying shared Perfect Day data');
select is((select count(*) from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000702' and reason_code='PERFECT_DAY_BONUS' and current_xp>0),0::bigint,'shared Perfect Day reverses when deletion leaves no eligible tracker');

-- Reconstructed XP is not attributable, so rejection must leave the Bin item
-- and deletion ledger unchanged.
insert into public.trackers(id,user_id,kind,status,name,definition,deleted_at)
values('00000000-0000-4000-8000-000000000782','00000000-0000-4000-8000-000000000703','habit','active','legacy fixture','{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000782","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}',clock_timestamp());
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values('00000000-0000-4000-8000-000000000703','legacy_opening_balance','LEGACY_XP_OPENING_BALANCE',current_date,42,1,'00000000-0000-4000-8000-000000000781','{"source":"fixture"}');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000703';
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000703','00000000-0000-4000-8000-000000000783','00000000-0000-4000-8000-000000000782',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000782'),'delete_wins')$$,'55000',null,'unattributed reconstructed XP fails closed');
reset role;
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000782'),1::bigint,'failed deletion leaves tracker intact');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id='00000000-0000-4000-8000-000000000782'),0::bigint,'failed deletion creates no tombstone');

-- Force an error after award reversals, ledger insertion, and entry deletion.
-- The function call must roll all of those writes back atomically.
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000704';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000791','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000792','schema_version',1,'kind','habit','status','active','name','rollback fixture','created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000792','kind','habit','status','active','createdAt',current_date::text||'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','rollback tracker created');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000793','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000794','tracker_id','00000000-0000-4000-8000-000000000792','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true))))->>'status','applied','rollback check-in earns attributable XP');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000795','tracker',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000792','schema_version',1,'kind','habit','status','active','name','rollback fixture','deleted_at',clock_timestamp(),'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000792','kind','habit','status','active','deletedAt',clock_timestamp(),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),'schedule',jsonb_build_object('kind','every-day')))))->>'status','applied','rollback tracker enters the Bin');
reset role;
create function public.test_abort_tracker_delete_after_progression() returns trigger language plpgsql as $$
begin
  if old.id='00000000-0000-4000-8000-000000000792'::uuid then
    raise exception 'intentional deletion rollback fixture' using errcode='P0001';
  end if;
  return old;
end;
$$;
create trigger zz_test_abort_tracker_delete after delete on public.trackers
for each row execute function public.test_abort_tracker_delete_after_progression();
create temporary table rollback_progression_events_before on commit drop as
  select * from public.progression_events where user_id='00000000-0000-4000-8000-000000000704';
create temporary table rollback_progression_xp_before on commit drop as
  select coalesce(sum(xp_delta),0)::bigint as total_xp
  from public.progression_events where user_id='00000000-0000-4000-8000-000000000704';
create temporary table rollback_award_state_before on commit drop as
  select * from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000704';
create temporary table rollback_reversal_ids_before on commit drop as
  select id from public.progression_events
  where user_id='00000000-0000-4000-8000-000000000704' and reason_code='AWARD_REVERSAL';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000704';
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000796','00000000-0000-4000-8000-000000000792',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000792'),'delete_wins')$$,'P0001',null,'failure after reconciliation rolls back the deletion transaction');
reset role;
drop trigger zz_test_abort_tracker_delete on public.trackers;
drop function public.test_abort_tracker_delete_after_progression();
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000792'),1::bigint,'rollback restores tracker');
select is((select count(*) from public.tracker_entries where id='00000000-0000-4000-8000-000000000794'),1::bigint,'rollback restores entry history');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id='00000000-0000-4000-8000-000000000792'),0::bigint,'rollback removes tentative deletion tombstone');
select ok(not exists (
  (select * from public.progression_events where user_id='00000000-0000-4000-8000-000000000704'
   except all select * from pg_temp.rollback_progression_events_before)
  union all
  (select * from pg_temp.rollback_progression_events_before
   except all select * from public.progression_events where user_id='00000000-0000-4000-8000-000000000704')
), 'failed deletion preserves every progression event ID and XP delta');
select is((select coalesce(sum(xp_delta),0)::bigint from public.progression_events where user_id='00000000-0000-4000-8000-000000000704'),
  (select total_xp from pg_temp.rollback_progression_xp_before),
  'failed deletion preserves the exact pre-attempt XP total');
select ok(not exists (
  (select * from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000704'
   except all select * from pg_temp.rollback_award_state_before)
  union all
  (select * from pg_temp.rollback_award_state_before
   except all select * from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000704')
), 'failed deletion leaves all progression award-state records unchanged');
select ok(not exists (
  (select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000704'
   and reason_code='AWARD_REVERSAL'
   except all select id from pg_temp.rollback_reversal_ids_before)
  union all
  (select id from pg_temp.rollback_reversal_ids_before
   except all select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000704'
     and reason_code='AWARD_REVERSAL')
), 'failed deletion leaves existing reversal IDs unchanged and no tentative reversal');
select * from finish();
rollback;
