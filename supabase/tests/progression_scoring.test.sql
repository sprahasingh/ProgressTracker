begin;
select plan(24);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000081','progression-scorer@example.test');
update public.progression_account_state set initialized_at=(current_date - 6)::timestamptz where user_id='00000000-0000-4000-8000-000000000081';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000811','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000801","schema_version":1,"kind":"habit","status":"active","name":"Read","created_at":"2026-10-01T00:00:00Z","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000801","kind":"habit","status":"active","createdAt":"2026-10-01T00:00:00Z","metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"}}}'
))->>'status','applied'::text,'tracker creation succeeds through the revision-checked RPC');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000812','tracker_entry',null,
  ('{"id":"00000000-0000-4000-8000-000000000802","tracker_id":"00000000-0000-4000-8000-000000000801","entry_date":"' || current_date::text || '","outcome":"recorded","entry_values":{"done":true},"note":"private note","created_at":"2026-10-12T12:00:00Z"}')::jsonb
))->>'status','applied'::text,'qualifying check-in is accepted');
select is((select coalesce(sum(event.xp_delta),0) from public.progression_events event
where event.user_id='00000000-0000-4000-8000-000000000081'
  and (event.id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')
    or event.reverses_event_id in (select award.id from public.progression_events award
      join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
      where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802'))),10::bigint,'server awards ten XP from the authenticated saved check-in');
select ok(not exists(select 1 from public.progression_events where metadata::text like '%private note%'),'event metadata does not copy the check-in note');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000813','tracker_entry',1,
  ('{"id":"00000000-0000-4000-8000-000000000802","tracker_id":"00000000-0000-4000-8000-000000000801","entry_date":"' || current_date::text || '","outcome":"recorded","entry_values":{"done":false},"note":"","created_at":"2026-10-12T12:00:00Z"}')::jsonb
))->>'status','applied'::text,'correction updates the check-in');
select is((select coalesce(sum(event.xp_delta),0) from public.progression_events event
where event.user_id='00000000-0000-4000-8000-000000000081'
  and (event.id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')
    or event.reverses_event_id in (select award.id from public.progression_events award
      join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
      where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802'))),0::bigint,'correction appends a reversal rather than leaving unearned XP');
select is((select count(*) from public.progression_events reversal where reversal.reason_code='AWARD_REVERSAL'
  and reversal.reverses_event_id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')),1::bigint,'one reversal is recorded for the corrected source');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000814','tracker_entry',1,
  ('{"id":"00000000-0000-4000-8000-000000000802","tracker_id":"00000000-0000-4000-8000-000000000801","entry_date":"' || current_date::text || '","outcome":"recorded","entry_values":{"done":true},"note":"","created_at":"2026-10-12T12:00:00Z"}')::jsonb
))->>'status','conflict'::text,'stale check-in revisions do not create awards');
select is((select coalesce(sum(event.xp_delta),0) from public.progression_events event
where event.user_id='00000000-0000-4000-8000-000000000081'
  and (event.id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')
    or event.reverses_event_id in (select award.id from public.progression_events award
      join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
      where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802'))),0::bigint,'stale requests leave the score unchanged');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000815','tracker_entry',2,
  ('{"id":"00000000-0000-4000-8000-000000000802","tracker_id":"00000000-0000-4000-8000-000000000801","entry_date":"' || current_date::text || '","outcome":"recorded","entry_values":{"done":true},"note":"","created_at":"2026-10-12T12:00:00Z"}')::jsonb
))->>'status','applied'::text,'a corrected qualifying check-in restores its active award');
select is((select coalesce(sum(event.xp_delta),0) from public.progression_events event
where event.user_id='00000000-0000-4000-8000-000000000081'
  and (event.id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')
    or event.reverses_event_id in (select award.id from public.progression_events award
      join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
      where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802'))),10::bigint,'restoring the qualifying source restores net XP exactly once');
select is((select count(*) from public.progression_events where reason_code='DAILY_CHECK_IN_COMPLETED'),2::bigint,'restoration appends a new explainable award generation');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000816','tracker_entry',3,
  ('{"id":"00000000-0000-4000-8000-000000000802","tracker_id":"00000000-0000-4000-8000-000000000801","entry_date":"' || current_date::text || '","outcome":"recorded","entry_values":{"done":false},"note":"","created_at":"2026-10-12T12:00:00Z"}')::jsonb
))->>'status','applied'::text,'a later correction can reverse the restored award');
select is((select coalesce(sum(event.xp_delta),0) from public.progression_events event
where event.user_id='00000000-0000-4000-8000-000000000081'
  and (event.id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')
    or event.reverses_event_id in (select award.id from public.progression_events award
      join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
      where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802'))),0::bigint,'repeated corrections never increase net XP');
select is((select count(*) from public.progression_events reversal where reversal.reason_code='AWARD_REVERSAL'
  and reversal.reverses_event_id in (select award.id from public.progression_events award
    join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
    where award.user_id='00000000-0000-4000-8000-000000000081' and award.reason_code='DAILY_CHECK_IN_COMPLETED' and source.source_id='00000000-0000-4000-8000-000000000802')),2::bigint,'each credited generation has at most one reversal');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000817','tracker',null,
  jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000803','schema_version',1,'kind','habit','status','active','name','Streak test',
    'created_at',(current_date - 6)::text || 'T00:00:00Z',
    'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000803','kind','habit','status','active',
      'createdAt',(current_date - 6)::text || 'T00:00:00Z','metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
      'schedule',jsonb_build_object('kind','every-day'))
  )
))->>'status','applied'::text,'streak tracker is accepted through the revision-checked sync boundary');
select is((select count(*) from (
  select public.apply_tracker_sync_operation(
    '00000000-0000-4000-8000-000000000081',
    md5('streak-entry:' || (current_date - 6 + day_offset)::text)::uuid,
    'tracker_entry',null,
    jsonb_build_object('id',md5('streak-source:' || (current_date - 6 + day_offset)::text)::uuid,
      'tracker_id','00000000-0000-4000-8000-000000000803','entry_date',(current_date - 6 + day_offset)::text,
      'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','',
      'created_at',(current_date - 6 + day_offset)::text || 'T12:00:00Z')) as result
  from generate_series(0,6) day_offset
) saved where result->>'status'='applied'),7::bigint,'seven consecutive eligible check-ins are accepted');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000081' and reason_code='STREAK_MILESTONE'),35::bigint,'the seven-day tracker milestone awards thirty-five XP');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000081' and reason_code='STREAK_MILESTONE'),1::bigint,'the seven-day milestone is awarded once');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000818','tracker_entry',1,
  jsonb_build_object('id',md5('streak-source:' || (current_date - 6)::text)::uuid,
    'tracker_id','00000000-0000-4000-8000-000000000803','entry_date',(current_date - 6)::text,
    'outcome','recorded','entry_values',jsonb_build_object('done',false),'note','',
    'created_at',(current_date - 6)::text || 'T12:00:00Z')
))->>'status','applied'::text,'a historical correction is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000081' and award_key=md5('00000000-0000-4000-8000-000000000081:streak:00000000-0000-4000-8000-000000000803:7')::uuid),0,'a historical correction reverses the active milestone credit');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000819','tracker_entry',2,
  jsonb_build_object('id',md5('streak-source:' || (current_date - 6)::text)::uuid,
    'tracker_id','00000000-0000-4000-8000-000000000803','entry_date',(current_date - 6)::text,
    'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','',
    'created_at',(current_date - 6)::text || 'T12:00:00Z')
))->>'status','applied'::text,'restoring the historical source is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000081' and award_key=md5('00000000-0000-4000-8000-000000000081:streak:00000000-0000-4000-8000-000000000803:7')::uuid),35,'requalified streak history restores one net milestone award');
set local role authenticated;
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000081' and reason_code='STREAK_MILESTONE'),2::bigint,'requalification appends a distinct award generation instead of duplicating a live credit');

reset role;
select * from finish();
rollback;
