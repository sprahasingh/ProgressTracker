begin;
select plan(160);

select ok(to_regclass('public.tracker_deletion_ledger') is not null, 'durable deletion ledger exists');
select ok(to_regclass('public.tracker_deletion_cleanup_control') is not null, 'cleanup control exists');
select is((select relrowsecurity from pg_class where oid = 'public.tracker_deletion_ledger'::regclass), true, 'ledger RLS is enabled');
select is((select relrowsecurity from pg_class where oid = 'public.tracker_deletion_cleanup_control'::regclass), true, 'cleanup control RLS is enabled');
select ok(exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'tracker_deletion_ledger' and policyname = 'tracker_deletion_ledger_select_own' and roles @> array['authenticated']::name[] and cmd = 'SELECT'), 'only an owner-scoped ledger read policy exists');
select ok(has_table_privilege('authenticated', 'public.tracker_deletion_ledger', 'select'), 'authenticated can read its RLS-filtered ledger');
select ok(not has_table_privilege('anon', 'public.tracker_deletion_ledger', 'select'), 'anonymous cannot read the ledger');
select ok(not has_table_privilege('authenticated', 'public.tracker_deletion_ledger', 'insert'), 'authenticated cannot forge ledger rows');
select ok(exists(select 1 from information_schema.columns where table_schema='public' and table_name='tracker_deletion_ledger' and column_name='wins_retention'), 'deletion ledger records the selected Wins policy');
select is((select relrowsecurity from pg_class where oid='public.progression_retained_achievement_progress'::regclass),true,'retained achievement progress enforces RLS');
select ok(has_table_privilege('authenticated','public.progression_retained_achievement_progress','select'),'owners can read retained progress through RLS');
select ok(not has_table_privilege('authenticated','public.progression_retained_achievement_progress','insert'),'clients cannot forge retained progression snapshots');
select ok(to_regclass('public.progression_retained_reward_context') is not null, 'retained reward context table exists');
select is((select relrowsecurity from pg_class where oid='public.progression_retained_reward_context'::regclass),true,'retained reward context enforces RLS');
select ok(has_table_privilege('authenticated','public.progression_retained_reward_context','select'),'owners can read retained reward context through RLS');
select ok(not has_table_privilege('authenticated','public.progression_retained_reward_context','insert'),'clients cannot forge retained reward context');
select ok(not has_table_privilege('anon','public.progression_retained_reward_context','select'),'anonymous users cannot read retained reward context');
select is((select count(*) from information_schema.columns where table_schema='public' and table_name='progression_retained_reward_context' and column_name in ('tracker_id','entry_id','source_id','note','entry_values','tracker_definition')),0::bigint,'retained reward context has no tracker, entry, or activity-content columns');
select is((select count(*) from pg_constraint where conrelid='public.progression_retained_reward_context'::regclass and contype='f' and confrelid='auth.users'::regclass and confdeltype='c'),1::bigint,'retained reward context cascades with account deletion and has no operational foreign keys');
select is((select relrowsecurity from pg_class where oid='public.progression_retained_achievement_unlocks'::regclass), true, 'retained achievement markers enforce RLS');
select ok(has_table_privilege('authenticated','public.progression_retained_achievement_unlocks','select'), 'owners can read retained achievement markers through RLS');
select ok(not has_function_privilege('anon', 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)', 'execute'), 'anonymous cannot permanently delete');
select ok((select not exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') from pg_proc where oid = 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)'::regprocedure), 'PUBLIC cannot permanently delete');
select ok(has_function_privilege('authenticated', 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)', 'execute'), 'authenticated can request owner-checked permanent deletion');
select ok(not has_function_privilege('anon','public.permanently_delete_tracker(uuid,uuid,uuid,bigint,text)','execute'), 'anonymous cannot select a Wins deletion mode');
select ok(has_function_privilege('authenticated','public.permanently_delete_tracker(uuid,uuid,uuid,bigint,text)','execute'), 'authenticated can request owner-checked deletion with an explicit Wins mode');
select ok(has_table_privilege('authenticated', 'public.trackers', 'select'), 'authenticated retains tracker reads');
select ok(not has_table_privilege('authenticated', 'public.trackers', 'update'), 'tracker updates cannot bypass the serialized RPC');
select ok(has_table_privilege('authenticated', 'public.tracker_entries', 'select'), 'authenticated retains tracker-entry reads');
select ok(not has_table_privilege('authenticated', 'public.tracker_entries', 'insert'), 'entry inserts cannot bypass the serialized RPC');
select ok((select convalidated and pg_get_constraintdef(oid) like '%1, 2, 3%' from pg_constraint where conrelid='public.trackers'::regclass and conname='trackers_schema_version_check'), 'permanent deletion preserves tracker schema versions 1 through 3');
select ok(case when to_regclass('cron.job') is null then true else
  (xpath('/table/row/safe/text()', query_to_xml(
    $query$select count(*) = 1 and bool_and(schedule = '0 3 * * *' and active
      and command like '%public.purge_expired_tracker_bin()%') as safe
      from cron.job where jobname = 'progress-tracker-bin-cleanup'$query$,
    true, false, '')))[1]::text = 'true'
  end, 'cleanup scheduler is either absent or has exactly one daily 03:00 UTC job');
select ok(current_setting('cron.timezone', true) is null or upper(current_setting('cron.timezone', true)) in ('UTC', 'GMT', 'ETC/UTC'), 'pg_cron schedule uses UTC-equivalent time');
select is((select enabled from public.tracker_deletion_cleanup_control where id), false, 'cleanup stays inert until operational verification');
select ok(to_regprocedure('public.guard_tracker_deletion_with_progression_history()') is not null
  and exists(select 1 from pg_trigger where tgname='trackers_guard_progression_deletion' and not tgisinternal),
  'progression deletion guard migration is installed');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000061', 'bin-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000000062', 'bin-owner-two@example.test');
insert into public.trackers (id, user_id, kind, status, name, definition, deleted_at) values
  ('00000000-0000-4000-8000-000000000661', '00000000-0000-4000-8000-000000000061', 'goal', 'active', 'Bin test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000661","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000662', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Expired test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000662","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000663', '00000000-0000-4000-8000-000000000062', 'goal', 'active', 'Restore test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000663","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000664', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Expired stale restore',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000664","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000665', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Twenty-nine-day Bin item',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000665","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000666', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Thirty-day Bin item',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000666","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000667', '00000000-0000-4000-8000-000000000061', 'habit', 'active', 'Other owner expired item',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000667","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000668', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Active item',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000668","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null);
-- These rows model pre-existing retained history from before the database
-- date-window guard; new RPC writes below are still subject to that guard.
alter table public.tracker_entries disable trigger user;
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values, note, deleted_at) values
  ('00000000-0000-4000-8000-000000000761', '00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000661', '2026-10-09', 'recorded', '{"pages":4}', 'retained until purge', null),
  ('00000000-0000-4000-8000-000000000762', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000662', '2026-10-09', 'recorded', '{"minutes":20}', 'expired content', null),
  ('00000000-0000-4000-8000-000000000763', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000663', '2026-10-09', 'recorded', '{"steps":3}', 'restore history', null),
  ('00000000-0000-4000-8000-000000000764', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000664', '2026-10-09', 'recorded', '{"steps":8}', 'expired restore history', null),
  ('00000000-0000-4000-8000-000000000765', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000662', '2026-10-10', 'recorded', '{"minutes":30}', 'cleanup history', null);
-- Seed child history before moving fixture rows into the Bin. Live entries on a
-- binned tracker are intentionally rejected by the lifecycle guard.
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values, note, deleted_at) values
  ('00000000-0000-4000-8000-000000000768', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000668', '2026-10-11', 'recorded', '{"minutes":10}', 'protected history', null);
set constraints all immediate;
alter table public.tracker_entries enable trigger user;
update public.trackers
set deleted_at = case id
      when '00000000-0000-4000-8000-000000000661' then now() - interval '1 day'
      when '00000000-0000-4000-8000-000000000662' then now() - interval '31 days'
      when '00000000-0000-4000-8000-000000000664' then now() - interval '31 days'
      when '00000000-0000-4000-8000-000000000665' then now() - interval '29 days'
      when '00000000-0000-4000-8000-000000000666' then now() - interval '30 days'
      when '00000000-0000-4000-8000-000000000667' then now() - interval '31 days'
    end,
    definition = jsonb_set(definition, '{deletedAt}', to_jsonb(case id
      when '00000000-0000-4000-8000-000000000661' then now() - interval '1 day'
      when '00000000-0000-4000-8000-000000000662' then now() - interval '31 days'
      when '00000000-0000-4000-8000-000000000664' then now() - interval '31 days'
      when '00000000-0000-4000-8000-000000000665' then now() - interval '29 days'
      when '00000000-0000-4000-8000-000000000666' then now() - interval '30 days'
      when '00000000-0000-4000-8000-000000000667' then now() - interval '31 days'
    end), true)
where id in (
  '00000000-0000-4000-8000-000000000661','00000000-0000-4000-8000-000000000662',
  '00000000-0000-4000-8000-000000000664','00000000-0000-4000-8000-000000000665',
  '00000000-0000-4000-8000-000000000666','00000000-0000-4000-8000-000000000667'
);
insert into public.sync_operation_receipts(user_id, operation_id, entity, expected_revision, record_payload, result) values
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000861', 'tracker', 1,
   '{"id":"00000000-0000-4000-8000-000000000661","definition":{"name":"Bin test"}}', '{"status":"applied"}'),
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000862', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000761","tracker_id":"00000000-0000-4000-8000-000000000661","entry_values":{"pages":4}}', '{"status":"applied"}'),
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000863', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000661","tracker_id":"00000000-0000-4000-8000-000000000663","entry_values":{"steps":1}}', '{"status":"unrelated"}'),
  ('00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000864', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000765","tracker_id":"00000000-0000-4000-8000-000000000662","entry_values":{"minutes":30}}', '{"status":"applied"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000961','00000000-0000-4000-8000-000000000661',1)$$, '42501', null, 'another account cannot request deletion using the first owner ID');
select is((select count(*) from public.tracker_deletion_ledger), 0::bigint, 'cross-account attempt creates no ledger record');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000961','00000000-0000-4000-8000-000000000661',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000661'))->>'status'), 'deleted'::text, 'owner permanently deletes a tombstoned tracker');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000661'), 0::bigint, 'tracker content is purged');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000661'), 0::bigint, 'associated progress history is purged');
select is((select count(*) from public.tracker_deletion_ledger where user_id = '00000000-0000-4000-8000-000000000061' and tracker_id = '00000000-0000-4000-8000-000000000661'), 1::bigint, 'durable account deletion marker remains');
reset role;
select is((select count(*) from public.sync_operation_receipts where user_id = '00000000-0000-4000-8000-000000000061' and ((entity='tracker' and record_payload->>'id' = '00000000-0000-4000-8000-000000000661') or (entity='tracker_entry' and record_payload->>'tracker_id' = '00000000-0000-4000-8000-000000000661'))), 0::bigint, 'receipts containing deleted content are erased');
select is((select count(*) from public.sync_operation_receipts where user_id = '00000000-0000-4000-8000-000000000061' and operation_id = '00000000-0000-4000-8000-000000000863'), 1::bigint, 'unrelated entry receipt with a colliding row UUID is preserved');
-- Simulate a stale receipt reintroduced by a restored/outdated client. The table
-- remains private; only the security-definer sync RPC may inspect or replay it.
insert into public.sync_operation_receipts(user_id, operation_id, entity, expected_revision, record_payload, result) values
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000862', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000761","tracker_id":"00000000-0000-4000-8000-000000000661","entry_values":{"pages":4}}', '{"status":"applied","record":{"id":"00000000-0000-4000-8000-000000000761"}}'),
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000861', 'tracker', null,
   '{"id":"00000000-0000-4000-8000-000000000661","schema_version":1,"kind":"goal","status":"active","name":"stale tracker","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000661","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}',
   '{"status":"applied","record":{"id":"00000000-0000-4000-8000-000000000661","name":"stale tracker"}}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000665','00000000-0000-4000-8000-000000000061',1,'goal','active','stale direct write','{}')$$,
  '42501', null, 'revoked direct tracker writes cannot bypass the deletion ledger');
select throws_ok($$insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome) values
  ('00000000-0000-4000-8000-000000000765','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000661','2026-10-10','recorded')$$,
  '42501', null, 'revoked direct entry writes cannot bypass the deletion ledger');
select throws_ok($$update public.trackers set name = 'stale direct update' where id = '00000000-0000-4000-8000-000000000661'$$,
  '42501', null, 'direct tracker updates remain blocked for authenticated clients');
select throws_ok($$delete from public.trackers where id = '00000000-0000-4000-8000-000000000661'$$,
  '42501', null, 'direct tracker deletes remain blocked for authenticated clients');
select throws_ok($$update public.tracker_entries set note = 'stale direct update' where id = '00000000-0000-4000-8000-000000000761'$$,
  '42501', null, 'direct entry updates remain blocked for authenticated clients');
select throws_ok($$delete from public.tracker_entries where id = '00000000-0000-4000-8000-000000000761'$$,
  '42501', null, 'direct entry deletes remain blocked for authenticated clients');
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000961','00000000-0000-4000-8000-000000000661',1)->>'status'), 'already_deleted'::text, 'repeated deletion request is idempotent');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000862','tracker_entry',1,
  '{"id":"00000000-0000-4000-8000-000000000761","tracker_id":"00000000-0000-4000-8000-000000000661","entry_date":"2026-10-09","outcome":"recorded","entry_values":{"pages":4}}')->>'status'), 'permanently_deleted'::text, 'old matching receipt cannot replay deleted entry data');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000861','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000661","schema_version":1,"kind":"goal","status":"active","name":"stale tracker","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000661","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'permanently_deleted'::text, 'old matching tracker receipt cannot replay deleted tracker data');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000661'), 0::bigint, 'replaying a stale tracker receipt does not resurrect deleted content');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000962','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000661","schema_version":1,"kind":"goal","status":"active","name":"stale tracker","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000661","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'permanently_deleted'::text, 'stale tracker upload is rejected by the ledger');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000963','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000761","tracker_id":"00000000-0000-4000-8000-000000000661","entry_date":"2026-10-09","outcome":"recorded","entry_values":{"pages":4}}')->>'status'), 'permanently_deleted'::text, 'stale child entry upload is rejected by the parent ledger');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((select count(*) from public.tracker_deletion_ledger), 0::bigint, 'another account cannot observe deletion ledger rows');

select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000964','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000663","schema_version":1,"kind":"goal","status":"active","name":"Restore test","deleted_at":"2026-10-09T00:00:00Z","definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000663","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'applied'::text, 'soft-deleted tracker update enters the Bin');
select ok((select deleted_at > '2026-10-09T00:00:00Z'::timestamptz from public.trackers where id = '00000000-0000-4000-8000-000000000663'), 'server, not client, starts the recovery clock');
select is((select (definition->>'deletedAt')::timestamptz from public.trackers where id = '00000000-0000-4000-8000-000000000663'), (select deleted_at from public.trackers where id = '00000000-0000-4000-8000-000000000663'), 'serialized tracker and server tombstone timestamps agree');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000965','tracker',2,
  '{"id":"00000000-0000-4000-8000-000000000663","schema_version":1,"kind":"goal","status":"active","name":"Restore test","deleted_at":null,"definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000663","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'applied'::text, 'restore during the grace period is accepted');
select is((select deleted_at from public.trackers where id = '00000000-0000-4000-8000-000000000663'), null::timestamptz, 'restored tracker is active');
select is((select count(*) from public.tracker_entries where id = '00000000-0000-4000-8000-000000000763'), 1::bigint, 'restore preserves associated history');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000967','tracker',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000664'),
  '{"id":"00000000-0000-4000-8000-000000000664","schema_version":1,"kind":"habit","status":"active","name":"Expired stale restore","deleted_at":null,"definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000664","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'permanently_deleted'::text, 'stale restore after 30 days commits permanent deletion before accepting the upload');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000664'), 0::bigint, 'late restore cannot recreate expired tracker content');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id = '00000000-0000-4000-8000-000000000664'), 1::bigint, 'late restore records durable deletion');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000664'), 0::bigint, 'late restore purges associated history');
select ok(pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure) like '%pg_advisory_xact_lock%', 'sync writes serialize by account and tracker');
select ok(pg_get_functiondef('public.permanently_delete_tracker(uuid,uuid,uuid,bigint)'::regprocedure) like '%pg_advisory_xact_lock%', 'manual deletion serializes with sync writes');
select ok(pg_get_functiondef('public.purge_expired_tracker_bin()'::regprocedure) like '%pg_advisory_xact_lock%', 'scheduled cleanup serializes with sync writes');
select ok(pg_get_functiondef('public.purge_expired_tracker_bin()'::regprocedure) like '%deleted_at%' and pg_get_functiondef('public.purge_expired_tracker_bin()'::regprocedure) like '%30 days%', 'cleanup uses an inclusive full 30-day server-time boundary');

reset role;
delete from public.tracker_deletion_cleanup_control where id;
select is(public.purge_expired_tracker_bin(), 0, 'missing cleanup control row leaves the cleanup disabled');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000662'), 1::bigint, 'missing control row retains expired tracker content');
insert into public.tracker_deletion_cleanup_control(id, enabled) values (true, false) on conflict (id) do update set enabled = false;
select is(public.purge_expired_tracker_bin(), 0, 'scheduled cleanup is inert before verification');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000662'), 1::bigint, 'expired content is retained while cleanup switch is off');
update public.tracker_deletion_cleanup_control set enabled = true, updated_at = clock_timestamp() where id;
select is(public.purge_expired_tracker_bin(), 3, 'cleanup purges only Bin items at least 30 days old across owners');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000662'), 0::bigint, 'expired tracker row is purged');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000662'), 0::bigint, 'expired tracker history is purged');
select is((select count(*) from public.tracker_deletion_ledger where user_id = '00000000-0000-4000-8000-000000000062' and tracker_id = '00000000-0000-4000-8000-000000000662'), 1::bigint, 'scheduled cleanup retains the permanent ledger row');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000665'), 1::bigint, 'tracker deleted 29 days ago is retained');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000666'), 0::bigint, 'tracker at the 30-day boundary is eligible');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000668' and deleted_at is null), 1::bigint, 'active tracker is retained');
select is((select count(*) from public.tracker_deletion_ledger where user_id = '00000000-0000-4000-8000-000000000061' and tracker_id = '00000000-0000-4000-8000-000000000667'), 1::bigint, 'other owner deletion is recorded only under that owner');
select is((select count(*) from public.sync_operation_receipts where user_id = '00000000-0000-4000-8000-000000000062' and operation_id = '00000000-0000-4000-8000-000000000864'), 0::bigint, 'cleanup removes sync receipts containing expired tracker history');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000968','tracker',null,
  '{"id":"00000000-0000-4000-8000-000000000662","schema_version":1,"kind":"habit","status":"active","name":"Stale resurrection","deleted_at":null,"definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000662","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'permanently_deleted'::text, 'stale sync cannot recreate a tracker purged by scheduled cleanup');
select is(public.purge_expired_tracker_bin(), 0, 'repeated scheduled cleanup is idempotent');
insert into public.trackers (id, user_id, kind, status, name, definition, deleted_at) values
  ('00000000-0000-4000-8000-000000000669', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Rollback test item',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000669","kind":"habit","status":"active","startDate":"2026-10-10","metrics":[],"schedule":{"kind":"every-day"}}', null);
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values, note, deleted_at) values
  ('00000000-0000-4000-8000-000000000769', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000669', '2026-10-10', 'recorded', '{"minutes":5}', 'rollback history', null);
update public.trackers set deleted_at=now()-interval '31 days',
  definition=jsonb_set(definition,'{deletedAt}',to_jsonb(now()-interval '31 days'),true)
where id='00000000-0000-4000-8000-000000000669';
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values ('00000000-0000-4000-8000-000000000062','check_in','DAILY_CHECK_IN_COMPLETED','2026-10-10',10,2,
  md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000769:daily-check-in-v1')::uuid,
  '{"rule":"10 XP per eligible completed check-in"}');
insert into public.progression_event_sources(user_id,event_id,tracker_id,source_id,display_name)
select e.user_id,e.id,'00000000-0000-4000-8000-000000000669','00000000-0000-4000-8000-000000000769','Scheduled cleanup tracker'
from public.progression_events e where e.user_id='00000000-0000-4000-8000-000000000062'
  and e.idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000769:daily-check-in-v1')::uuid;
create function public.tracker_bin_test_reject_delete() returns trigger
language plpgsql
as $$
begin
  if old.id = '00000000-0000-4000-8000-000000000669'::uuid then
    raise exception 'injected cleanup failure' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
create trigger tracker_bin_test_reject_delete before delete on public.trackers
for each row execute function public.tracker_bin_test_reject_delete();
create temporary table tracker_bin_snapshot_before_failure as
select count(*)::bigint as row_count, max(retained_at) as latest_snapshot,
       (select count(*)::bigint from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062') as reward_context_count
from public.progression_retained_achievement_progress
where user_id='00000000-0000-4000-8000-000000000062';
select throws_ok($$select public.purge_expired_tracker_bin()$$, 'P0001', 'injected cleanup failure', 'failed finalization aborts the cleanup transaction');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000669'), 1::bigint, 'failed cleanup retains the tracker row');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000669'), 1::bigint, 'failed cleanup rolls back child-history deletion');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id = '00000000-0000-4000-8000-000000000669'), 0::bigint, 'failed cleanup rolls back its tentative ledger insert');
select is(row((select count(*)::bigint from public.progression_retained_achievement_progress where user_id='00000000-0000-4000-8000-000000000062'),
  (select max(retained_at) from public.progression_retained_achievement_progress where user_id='00000000-0000-4000-8000-000000000062')),
  (select row(row_count,latest_snapshot) from tracker_bin_snapshot_before_failure),'failed cleanup rolls back its tentative Wins snapshot');
select is((select count(*) from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062'),(select reward_context_count from tracker_bin_snapshot_before_failure),'failed cleanup rolls back its tentative reward context');
drop trigger tracker_bin_test_reject_delete on public.trackers;
drop function public.tracker_bin_test_reject_delete();
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values ('00000000-0000-4000-8000-000000000062','legacy_opening_balance','LEGACY_XP_OPENING_BALANCE','2026-10-14',50,1,
  '00000000-0000-4000-8000-000000000968','{"label":"XP reconstructed from past activity"}');
insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,idempotency_key)
values ('00000000-0000-4000-8000-000000000062','first-step',1,1,'unlocked','test-blocked-delete-unlock');
insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,source_date,idempotency_key)
values
 ('00000000-0000-4000-8000-000000000062','momentum',1,1,'unlocked','2026-10-10','test-retained-momentum'),
 ('00000000-0000-4000-8000-000000000062','first-flame',1,1,'unlocked','2026-10-11','test-retained-flame'),
 ('00000000-0000-4000-8000-000000000062','milestone-maker',1,1,'unlocked','2026-10-12','test-retained-goal-badge'),
 ('00000000-0000-4000-8000-000000000062','dedicated',1,1,'unlocked','2026-10-12','test-retained-dedicated-1'),
 ('00000000-0000-4000-8000-000000000062','dedicated',1,2,'unlocked','2026-10-13','test-retained-dedicated-2');
insert into public.progression_achievement_progress(user_id,achievement_id,progress,target,current_tier,repeatable,source_date)
values
 ('00000000-0000-4000-8000-000000000062','first-step',1,1,1,false,'2026-10-11'),
 ('00000000-0000-4000-8000-000000000062','momentum',3,3,1,false,'2026-10-10'),
 ('00000000-0000-4000-8000-000000000062','first-flame',7,7,1,false,'2026-10-11'),
 ('00000000-0000-4000-8000-000000000062','milestone-maker',1,1,1,false,'2026-10-12'),
 ('00000000-0000-4000-8000-000000000062','dedicated',250,100,2,true,'2026-10-13')
on conflict(user_id,achievement_id) do update set progress=excluded.progress,target=excluded.target,
  current_tier=excluded.current_tier,repeatable=excluded.repeatable,source_date=excluded.source_date;
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values ('00000000-0000-4000-8000-000000000062','check_in','DAILY_CHECK_IN_COMPLETED','2026-10-11',10,2,
  md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid,
  '{"rule":"10 XP per eligible completed check-in"}');
insert into public.progression_event_sources(user_id,event_id,tracker_id,source_id,display_name)
select e.user_id,e.id,t.id,'00000000-0000-4000-8000-000000000768','Sensitive tracker display name'
from public.progression_events e join public.trackers t on t.id='00000000-0000-4000-8000-000000000668'
where e.user_id='00000000-0000-4000-8000-000000000062'
  and e.idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid;
update public.progression_achievement_events set source_event_id=(
  select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'
    and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid
), source_reference='{"tracker":"Sensitive tracker display name"}'::jsonb
where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step' and event_type='unlocked';
update public.progression_achievement_progress set source_event_id=(
  select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'
    and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid
) where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step';
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values ('00000000-0000-4000-8000-000000000062','streak_milestone','STREAK_MILESTONE','2026-10-12',25,2,
  '00000000-0000-4000-8000-000000000971','{"milestone_days":7}');
insert into public.progression_event_sources(user_id,event_id,tracker_id,display_name)
select '00000000-0000-4000-8000-000000000062',id,'00000000-0000-4000-8000-000000000668','Private streak tracker'
from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'
  and idempotency_key='00000000-0000-4000-8000-000000000971';
-- Goal rewards and account-wide Perfect Day rewards must remain in Wins too.
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata)
values
 ('00000000-0000-4000-8000-000000000062','goal_milestone','GOAL_MILESTONE','2026-10-09',25,2,'00000000-0000-4000-8000-000000000981','{"rule":"goal milestone"}'),
 ('00000000-0000-4000-8000-000000000062','goal_completed','GOAL_COMPLETED','2026-10-10',100,2,'00000000-0000-4000-8000-000000000982','{"rule":"goal completed"}'),
 ('00000000-0000-4000-8000-000000000062','daily_bonus','PERFECT_DAY_BONUS','2026-10-10',20,2,'00000000-0000-4000-8000-000000000983','{"rule":"all eligible trackers completed"}');
insert into public.progression_event_sources(user_id,event_id,tracker_id,display_name)
select e.user_id,e.id,'00000000-0000-4000-8000-000000000668','Private goal tracker'
from public.progression_events e
where e.user_id='00000000-0000-4000-8000-000000000062'
  and e.idempotency_key in ('00000000-0000-4000-8000-000000000981','00000000-0000-4000-8000-000000000982');
insert into public.progression_award_state(user_id,award_key,reason_code,effective_date,tracker_id,source_id,current_xp,current_event_id,generation)
select e.user_id,e.idempotency_key,'DAILY_CHECK_IN_COMPLETED',e.effective_date,s.tracker_id,s.source_id,10,e.id,1
from public.progression_events e join public.progression_event_sources s on s.user_id=e.user_id and s.event_id=e.id
where e.user_id='00000000-0000-4000-8000-000000000062'
  and e.idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid
on conflict(user_id,award_key) do update set tracker_id=excluded.tracker_id,source_id=excluded.source_id,
  current_xp=excluded.current_xp,current_event_id=excluded.current_event_id,generation=excluded.generation;
update public.trackers set deleted_at = clock_timestamp(),
  definition = jsonb_set(definition, '{deletedAt}', to_jsonb(clock_timestamp()), true)
where id = '00000000-0000-4000-8000-000000000668';
select ok(coalesce((select pg_get_triggerdef(oid) like '%old.definition%' and pg_get_triggerdef(oid) like '%deletedAt%'
  from pg_trigger where tgname = 'trackers_progression_definition_changed_update'), false), 'Bin-only updates skip historical progression reconciliation');
create temporary table tracker_bin_achievement_progress_before_delete as
select count(*)::bigint as row_count,
       coalesce(sum(progress),0)::numeric as total_progress,
       coalesce(sum(current_tier),0)::bigint as total_tier
from public.progression_achievement_progress
where user_id='00000000-0000-4000-8000-000000000062';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000970','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000770","tracker_id":"00000000-0000-4000-8000-000000000668","entry_date":"2026-10-14","outcome":"recorded","entry_values":{"minutes":1}}')->>'status'), 'parent_in_bin'::text, 'server rejects live check-ins while tracker is in the Bin');
reset role;
select throws_ok($$delete from public.trackers where id='00000000-0000-4000-8000-000000000668'$$,
  '55000', 'permanent tracker deletion requires an explicit safe Wins retention choice', 'direct deletion is blocked by the progression guard');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000969','00000000-0000-4000-8000-000000000668',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000668'),'delete_wins')$$,
  '55000', 'Wins history contains reconstructed, incomplete, or unattributed rewards and cannot be removed safely. Choose Keep my Wins history.', 'Delete Wins refuses reconstructed, shared, goal, and achievement rewards');
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000969','00000000-0000-4000-8000-000000000668',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000668'),'delete_wins')$$,
  '55000', 'Wins history contains reconstructed, incomplete, or unattributed rewards and cannot be removed safely. Choose Keep my Wins history.', 'repeated unsupported choice remains safe');
reset role;
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000668'), 1::bigint, 'guarded deletion retains tracker data');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000668' and note='protected history'), 1::bigint, 'guarded deletion retains tracker history');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id = '00000000-0000-4000-8000-000000000668'), 0::bigint, 'guarded deletion creates no permanent tombstone');
select is((select sum(xp_delta) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000062'), 240::bigint, 'guarded deletion leaves authoritative XP unchanged');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'),7::bigint,'guarded deletion leaves every reward event unchanged');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step' and event_type='unlocked'), 1::bigint, 'guarded deletion preserves earned achievement history');
select is(row((select count(*)::bigint from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062'),
  (select coalesce(sum(progress),0)::numeric from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062'),
  (select coalesce(sum(current_tier),0)::bigint from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062')),
  (select row(row_count,total_progress,total_tier) from tracker_bin_achievement_progress_before_delete),'guarded deletion leaves all achievement progress unchanged');
select is((select count(*) from public.progression_retained_achievement_unlocks where user_id='00000000-0000-4000-8000-000000000062'),0::bigint,'refused deletion creates no retained achievement markers');
set local role authenticated;
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000968','00000000-0000-4000-8000-000000000668',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000668'),'keep_wins')->>'status'), 'deleted'::text, 'Keep Wins permanently deletes the tracker with explicit retention');
reset role;
create temporary table tracker_bin_reward_context_before_retry as
select count(*)::bigint as row_count from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062';
set local role authenticated;
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000968','00000000-0000-4000-8000-000000000668',1,'keep_wins')->>'status'),'already_deleted'::text,'repeated Keep Wins request returns the durable deletion result');
reset role;
select is((select count(*) from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062'),(select row_count from tracker_bin_reward_context_before_retry),'repeated Keep Wins request does not duplicate retained context');
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000668'),0::bigint,'Keep Wins removes the tracker row');
select is((select count(*) from public.tracker_entries where tracker_id='00000000-0000-4000-8000-000000000668'),0::bigint,'Keep Wins removes tracker entries and notes');
select is((select wins_retention from public.tracker_deletion_ledger where tracker_id='00000000-0000-4000-8000-000000000668'),'keep_wins'::text,'tombstone records the explicit retention choice');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'),240::bigint,'Keep Wins preserves reconstructed and earned XP and level basis');
select is((select count(*) from public.progression_event_sources where user_id='00000000-0000-4000-8000-000000000062' and tracker_id='00000000-0000-4000-8000-000000000668'),0::bigint,'Keep Wins removes tracker names and source references from retained events');
select is((select count(*) from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062' and context_kind='score'),4::bigint,'Keep Wins snapshots each tracker-linked score event once');
select is(row((select tracker_display_name from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062' and context_kind='score' and event_id=(select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid)),
  (select reward_reason_code from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062' and context_kind='score' and event_id=(select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid)),
  (select xp_delta from public.progression_retained_reward_context where user_id='00000000-0000-4000-8000-000000000062' and context_kind='score' and event_id=(select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid))),
  row('Sensitive tracker display name'::text,'DAILY_CHECK_IN_COMPLETED'::text,10::integer),'snapshot preserves the recorded historical tracker name, reward reason, and XP amount');
select ok(exists(select 1 from public.progression_retained_reward_context c join public.progression_events e on e.user_id=c.user_id and e.id=c.event_id where c.user_id='00000000-0000-4000-8000-000000000062' and c.context_kind='score' and e.idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid and c.source_effective_date=e.effective_date and c.recorded_at=e.recorded_at),'retained score context preserves the original date and earning timestamp');
select ok(exists(select 1 from public.progression_retained_reward_context c join public.progression_achievement_events a on a.user_id=c.user_id and a.id=c.event_id where c.user_id='00000000-0000-4000-8000-000000000062' and c.context_kind='achievement' and a.achievement_id='first-step' and c.tracker_display_name='Sensitive tracker display name' and c.reward_reason_code='DAILY_CHECK_IN_COMPLETED' and c.xp_delta=10 and c.recorded_at=a.recorded_at),'achievement history retains its original unlock date and tracker reward context');
select is((select count(*) from public.progression_retained_reward_context c join public.progression_events e on e.user_id=c.user_id and e.id=c.event_id where c.user_id='00000000-0000-4000-8000-000000000062' and c.context_kind='score' and e.reason_code='PERFECT_DAY_BONUS'),0::bigint,'shared Perfect Day reward remains account-scoped and is not attributed to the deleted tracker');
select ok(not exists(select 1 from public.progression_retained_reward_context c where c.user_id='00000000-0000-4000-8000-000000000062' and (to_jsonb(c)::text like '%00000000-0000-4000-8000-000000000668%' or to_jsonb(c)::text like '%00000000-0000-4000-8000-000000000768%' or to_jsonb(c)::text like '%protected history%' or to_jsonb(c)::text like '%"minutes":10%')),'retained context contains no tracker or entry identifiers or activity content');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((select count(*) from public.progression_retained_reward_context),5::bigint,'owner can read their retained score and achievement contexts');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
select is((select count(*) from public.progression_retained_reward_context),0::bigint,'RLS hides retained reward context from other accounts');
reset role;
select is((select count(*) from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000062' and tracker_id='00000000-0000-4000-8000-000000000668'),0::bigint,'Keep Wins anonymizes award state tracker references');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step' and event_type='unlocked'),1::bigint,'Keep Wins preserves the earned achievement event');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and event_type='unlocked'),6::bigint,'Keep Wins retains every single and repeatable unlock instance');
select is((select count(*) from public.progression_retained_achievement_unlocks where user_id='00000000-0000-4000-8000-000000000062'),6::bigint,'all earned badges and repeatable instances receive retention markers');
select is((select count(*) from public.progression_retained_achievement_progress where user_id='00000000-0000-4000-8000-000000000062'),(select count(*) from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062'),'progress toward every badge is retained');
select is((select progress from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='dedicated'),250::numeric,'repeatable progress does not decrease after reconciliation');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='dedicated'),2,'repeatable tier does not decrease');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='dedicated' and event_type='unlocked'),2::bigint,'repeatable award count remains intact');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and source_event_id is not null),0::bigint,'achievement history removes joinable score source identifiers');
select is((select count(*) from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062' and source_event_id=(select id from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000768:daily-check-in-v1')::uuid)),0::bigint,'achievement progress drops the deleted tracker source pointer');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and source_reference::text like '%Sensitive tracker%'),0::bigint,'achievement history removes tracker-identifying metadata');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and reason_code='STREAK_MILESTONE' and xp_delta=25),1::bigint,'previously earned streak milestone XP remains recorded');
select is((select count(*) from public.progression_event_sources where user_id='00000000-0000-4000-8000-000000000062' and display_name='Private streak tracker'),0::bigint,'milestone source no longer exposes the deleted tracker name');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and reason_code in ('GOAL_MILESTONE','GOAL_COMPLETED','PERFECT_DAY_BONUS')),3::bigint,'goal and account-wide shared reward events remain in history');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and reason_code in ('GOAL_MILESTONE','GOAL_COMPLETED','PERFECT_DAY_BONUS')),145::bigint,'goal and shared reward XP remains unchanged');
select is((select array_agg(effective_date order by idempotency_key) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062' and idempotency_key in ('00000000-0000-4000-8000-000000000981','00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000983')),array['2026-10-09'::date,'2026-10-10'::date,'2026-10-10'::date],'goal and shared reward earned dates remain unchanged');
select is((select count(*) from public.progression_event_sources where user_id='00000000-0000-4000-8000-000000000062' and display_name='Private goal tracker'),0::bigint,'goal reward source metadata no longer identifies the deleted tracker');
insert into public.progression_achievement_events(user_id,achievement_id,tier,generation,event_type,idempotency_key,reverses_event_id)
select user_id,achievement_id,tier,generation,'revoked','retained-test-revocation',id
from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step' and event_type='unlocked';
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and event_type='revoked' and idempotency_key='retained-test-revocation'),0::bigint,'retained achievement unlock cannot be revoked by later reconciliation');
select is((select count(*) from public.progression_retained_achievement_unlocks where user_id='00000000-0000-4000-8000-000000000062' and achievement_event_id=(select id from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='first-step' and event_type='unlocked')) ,1::bigint,'Keep Wins marks the badge as an account-level historical unlock');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000972','tracker_entry',null,
  '{"id":"00000000-0000-4000-8000-000000000772","tracker_id":"00000000-0000-4000-8000-000000000668","entry_date":"2026-10-14","outcome":"recorded","entry_values":{"minutes":1}}')->>'status'), 'permanently_deleted'::text, 'future stale uploads cannot recreate deleted tracker activity');
reset role;
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'),240::bigint,'deleted tracker cannot generate additional XP after Keep Wins');
reset role;
update public.tracker_deletion_cleanup_control set enabled=true where id=true;
select is(public.purge_expired_tracker_bin(),1,'scheduled cleanup deterministically applies Keep Wins after the 30-day expiry');
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000669'),0::bigint,'scheduled Keep Wins removes expired tracker data');
select is((select wins_retention from public.tracker_deletion_ledger where tracker_id='00000000-0000-4000-8000-000000000669'),'keep_wins'::text,'scheduled cleanup records its deterministic retention policy');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000062'),240::bigint,'scheduled Keep Wins preserves account XP');
select ok(exists(select 1 from public.progression_retained_reward_context c join public.progression_events e on e.user_id=c.user_id and e.id=c.event_id where c.user_id='00000000-0000-4000-8000-000000000062' and c.context_kind='score' and e.idempotency_key=md5('00000000-0000-4000-8000-000000000062:00000000-0000-4000-8000-000000000769:daily-check-in-v1')::uuid and c.tracker_display_name='Scheduled cleanup tracker' and c.reward_reason_code='DAILY_CHECK_IN_COMPLETED'),'scheduled cleanup applies Keep Wins reward-context retention');
select is((select count(*) from public.progression_retained_achievement_unlocks where user_id='00000000-0000-4000-8000-000000000062'),6::bigint,'scheduled Keep Wins preserves earned badges and repeatable instances');
select is((select progress from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000062' and achievement_id='dedicated'),250::numeric,'scheduled Keep Wins preserves achievement progress');
update public.tracker_deletion_cleanup_control set enabled=false where id=true;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000966','00000000-0000-4000-8000-000000000663',1)->>'status'), 'conflict'::text, 'stale revision cannot permanently delete a restored tracker');
select is((select deleted_at from public.trackers where id = '00000000-0000-4000-8000-000000000663'), null::timestamptz, 'stale revision leaves restored data unchanged');

reset role;
insert into public.trackers(id,user_id,kind,status,name,definition,deleted_at) values
 ('00000000-0000-4000-8000-000000000670','00000000-0000-4000-8000-000000000061','habit','active','Target XP tracker','{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000670","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}',null),
 ('00000000-0000-4000-8000-000000000671','00000000-0000-4000-8000-000000000061','habit','active','Unrelated XP tracker','{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000671","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}',null);
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,note,deleted_at) values
 ('00000000-0000-4000-8000-000000000770','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000670','2026-10-12','recorded','{}','target private note',clock_timestamp()),
 ('00000000-0000-4000-8000-000000000771','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000671','2026-10-12','recorded','{}','unrelated note',clock_timestamp());
-- Tracker creation can unlock a tracker-count achievement in this fixture.
-- Remove that setup side effect so this account models exact per-entry XP
-- without any achievement history, which is the supported Delete Wins case.
delete from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000061';
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key,metadata) values
 ('00000000-0000-4000-8000-000000000061','check_in','DAILY_CHECK_IN_COMPLETED','2026-10-12',10,2,md5('00000000-0000-4000-8000-000000000061:00000000-0000-4000-8000-000000000770:daily-check-in-v1')::uuid,'{"rule":"10 XP per eligible completed check-in"}'),
 ('00000000-0000-4000-8000-000000000061','check_in','DAILY_CHECK_IN_COMPLETED','2026-10-12',25,2,md5('00000000-0000-4000-8000-000000000061:00000000-0000-4000-8000-000000000771:daily-check-in-v1')::uuid,'{"rule":"10 XP per eligible completed check-in"}');
insert into public.progression_event_sources(user_id,event_id,tracker_id,source_id,display_name)
select e.user_id,e.id,t.id,entry.id,t.name
from public.progression_events e
join public.tracker_entries entry on e.user_id=entry.user_id and e.idempotency_key=md5(e.user_id::text||':'||entry.id::text||':daily-check-in-v1')::uuid
join public.trackers t on t.user_id=entry.user_id and t.id=entry.tracker_id
where e.user_id='00000000-0000-4000-8000-000000000061' and e.reason_code='DAILY_CHECK_IN_COMPLETED';
insert into public.progression_award_state(user_id,award_key,reason_code,effective_date,tracker_id,source_id,current_xp,current_event_id,generation)
select '00000000-0000-4000-8000-000000000061',e.idempotency_key,'DAILY_CHECK_IN_COMPLETED',e.effective_date,s.tracker_id,s.source_id,e.xp_delta,e.id,1
from public.progression_events e join public.progression_event_sources s on s.user_id=e.user_id and s.event_id=e.id
where e.user_id='00000000-0000-4000-8000-000000000061' and e.reason_code='DAILY_CHECK_IN_COMPLETED'
on conflict(user_id,award_key) do update set tracker_id=excluded.tracker_id,source_id=excluded.source_id,
  current_xp=excluded.current_xp,current_event_id=excluded.current_event_id,generation=excluded.generation;
update public.trackers set deleted_at=clock_timestamp(),
  definition=jsonb_set(definition,'{deletedAt}',to_jsonb(clock_timestamp()),true)
where id='00000000-0000-4000-8000-000000000670';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000061';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000973','00000000-0000-4000-8000-000000000670',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000670'),'delete_wins')->>'status'),'deleted'::text,'Delete Wins reverses exact tracker-attributed check-in XP');
select is((select count(*) from public.trackers where id='00000000-0000-4000-8000-000000000670'),0::bigint,'Delete Wins removes the target tracker');
select is((select count(*) from public.tracker_entries where tracker_id='00000000-0000-4000-8000-000000000670'),0::bigint,'Delete Wins removes target entries and notes');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000061'),25::bigint,'Delete Wins preserves unrelated XP and reverses only the target award');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000061' and reason_code='AWARD_REVERSAL' and reverses_event_id=(select id from public.progression_events where idempotency_key=md5('00000000-0000-4000-8000-000000000061:00000000-0000-4000-8000-000000000770:daily-check-in-v1')::uuid)),1::bigint,'Delete Wins writes exactly one source reversal');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000061' and source_id='00000000-0000-4000-8000-000000000771'),25,'unrelated award state remains active');
select is((select count(*) from public.progression_event_sources where user_id='00000000-0000-4000-8000-000000000061' and tracker_id='00000000-0000-4000-8000-000000000670'),0::bigint,'Delete Wins removes identifying tracker and entry source references');
select is((select wins_retention from public.tracker_deletion_ledger where user_id='00000000-0000-4000-8000-000000000061' and tracker_id='00000000-0000-4000-8000-000000000670'),'delete_wins'::text,'Delete Wins records its durable reconciliation choice');
set local role authenticated;
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000973','00000000-0000-4000-8000-000000000670',(select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000670'),'delete_wins')->>'status'),'already_deleted'::text,'repeated Delete Wins request is idempotent');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000061' and reason_code='AWARD_REVERSAL'),1::bigint,'repeated deletion does not duplicate XP reversals');
reset role;
select * from finish();
rollback;
