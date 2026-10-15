begin;
select plan(24);
alter table public.trackers disable trigger user;
alter table public.tracker_entries disable trigger user;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000091', 'progression-cutover-existing@example.test'),
  ('00000000-0000-4000-8000-000000000092', 'progression-cutover-new@example.test');
insert into public.app_settings (id,user_id,timezone,timezone_configured) values
 ('general','00000000-0000-4000-8000-000000000091','UTC',true),
 ('general','00000000-0000-4000-8000-000000000092','UTC',true)
on conflict (user_id) do update set timezone='UTC',timezone_configured=true;

select is((select count(*) from public.progression_account_state where user_id='00000000-0000-4000-8000-000000000091'),1::bigint,'an account receives one initialization state');
select is((select count(*) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000092' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 0::bigint, 'a new account does not receive an invented zero opening event');
select is((select legacy_xp_kind from public.progression_account_state where user_id='00000000-0000-4000-8000-000000000092'),'new_account','a new account has an explicit no-legacy-history state');
select is((select count(*) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000092' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 0::bigint, 'new-account initialization does not invent a zero opening event');
select ok(not has_function_privilege('authenticated', 'public.initialize_progression_account(uuid)', 'execute'), 'authenticated clients cannot invoke privileged initialization');
select ok(not has_function_privilege('anon', 'public.initialize_progression_account(uuid)', 'execute'), 'anonymous clients cannot invoke privileged initialization');

-- Recreate a pre-progression account with retained server history. Suppress
-- progression triggers while seeding the legacy fixture, then batch-initialize it.
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at) values
 ('00000000-0000-4000-8000-000000000911','00000000-0000-4000-8000-000000000091',1,'habit','active','Active history',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000911","kind":"habit","status":"active","metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"}}', '2026-10-01T00:00:00Z'),
 ('00000000-0000-4000-8000-000000000912','00000000-0000-4000-8000-000000000091',1,'habit','active','Archived history',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000912","kind":"habit","status":"active","metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"}}', '2026-10-01T00:00:00Z'),
 ('00000000-0000-4000-8000-000000000913','00000000-0000-4000-8000-000000000091',1,'habit','active','Same-day edit history',
  '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000913","kind":"habit","status":"active","metrics":[{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"}}', '2026-10-01T00:00:00Z');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000000921','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-01','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000922','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-02','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000923','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-03','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000924','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-04','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000925','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-05','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000926','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-06','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000927','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911','2026-10-07','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000928','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000912','2026-10-02','recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000929','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000911',current_date,'recorded','{"done":true}'),
 ('00000000-0000-4000-8000-000000000930','00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000913',current_date,'skipped','{"done":false}');
update public.trackers set status = 'archived', definition = jsonb_set(
  jsonb_set(definition, '{status}', '"archived"'::jsonb),
  '{archivedAt}', '"2026-10-03T00:00:00Z"'::jsonb
) where id = '00000000-0000-4000-8000-000000000912';
update public.tracker_entries set server_changed_at='2026-10-08T00:00:00Z' where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_achievement_accounts where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_events where user_id='00000000-0000-4000-8000-000000000091';
delete from public.progression_account_state where user_id='00000000-0000-4000-8000-000000000091';

-- The batch recovers retained historical XP as one estimate and does not
-- fabricate historical check-in transactions or retroactive achievements.
select is((select processed_accounts from public.initialize_progression_accounts_batch(1)),1,'one legacy account is initialized by one bounded batch');
select is((select xp_delta from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 140, 'opening estimate reconstructs active and archived tracker history including the cutover-day snapshot');
select is((select count(*) from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000091' and source_id='00000000-0000-4000-8000-000000000930'),0::bigint,'same-day skipped activity is not marked as represented in the opening estimate');
select is((select sum(xp_delta) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091'), 140::bigint, 'opening estimate is the only historical ledger transaction');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000091'),0::bigint,'the reconstructed opening estimate does not unlock historical achievements');
set constraints all immediate;
alter table public.trackers enable trigger user;
alter table public.tracker_entries enable trigger user;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000091';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000930','tracker_entry',1,jsonb_build_object('id','00000000-0000-4000-8000-000000000929','tracker_id','00000000-0000-4000-8000-000000000911','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','','created_at',current_date::text||'T00:00:00Z')))->>'status','applied'::text,'same-day baseline entry edits remain accepted');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000091','00000000-0000-4000-8000-000000000931','tracker_entry',1,jsonb_build_object('id','00000000-0000-4000-8000-000000000930','tracker_id','00000000-0000-4000-8000-000000000913','entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','','created_at',current_date::text||'T00:00:00Z')))->>'status','applied'::text,'same-day skipped entry can be completed after cutover');
reset role;
select is((select count(*) from public.progression_events e join public.progression_event_sources s on s.event_id=e.id and s.user_id=e.user_id where e.user_id='00000000-0000-4000-8000-000000000091' and e.reason_code='DAILY_CHECK_IN_COMPLETED' and s.source_id='00000000-0000-4000-8000-000000000930'),1::bigint,'completing previously skipped cutover-day activity receives one new check-in award');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000091'),170::bigint,'editing an entry already included in the estimate is not awarded twice, the skipped entry earns one check-in award, and the newly complete account day earns one shared Perfect Day bonus');
select is((select count(*) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 1::bigint, 'historical reconstruction creates one opening event, not per-entry historical awards');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000091' and reason_code='DAILY_CHECK_IN_COMPLETED'),1::bigint,'only the previously skipped post-cutover completion receives a check-in award');
select is((select metadata->>'calculation_version' from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 'legacy-tracker-rewards-v1', 'opening balance records the calculation version');
select ok((select metadata ? 'reconstructed_at' and metadata ? 'cutover_at' from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 'opening balance records reconstruction and cutover timestamps');
select ok((select initialized_at is not null and scoring_version = 1 from public.progression_account_state where user_id = '00000000-0000-4000-8000-000000000091'), 'cutover state records the account initialization version');

select public.initialize_progression_account('00000000-0000-4000-8000-000000000091');
select is((select count(*) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091' and reason_code = 'LEGACY_XP_OPENING_BALANCE'), 1::bigint, 'repeated initialization does not duplicate the opening event');
select is((select sum(xp_delta) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000091'), 170::bigint, 'repeated initialization leaves the account total unchanged after check-in and shared Perfect Day awards');

select ok(position('v_legacy_xp_kind := ''unavailable''' in pg_get_functiondef('public.initialize_progression_account(uuid)'::regprocedure)) > 0,
  'unrepresentable legacy balances are recorded as unavailable');
select ok(position('if v_opening_xp is not null then' in pg_get_functiondef('public.initialize_progression_account(uuid)'::regprocedure)) > 0,
  'the initializer skips an opening event when no representable balance exists');

select * from finish();
rollback;
