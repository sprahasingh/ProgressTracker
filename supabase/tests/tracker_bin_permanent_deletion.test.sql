begin;
select plan(61);

select ok(to_regclass('public.tracker_deletion_ledger') is not null, 'durable deletion ledger exists');
select ok(to_regclass('public.tracker_deletion_cleanup_control') is not null, 'cleanup control exists');
select is((select relrowsecurity from pg_class where oid = 'public.tracker_deletion_ledger'::regclass), true, 'ledger RLS is enabled');
select is((select relrowsecurity from pg_class where oid = 'public.tracker_deletion_cleanup_control'::regclass), true, 'cleanup control RLS is enabled');
select ok(exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'tracker_deletion_ledger' and policyname = 'tracker_deletion_ledger_select_own' and roles @> array['authenticated']::name[] and cmd = 'SELECT'), 'only an owner-scoped ledger read policy exists');
select ok(has_table_privilege('authenticated', 'public.tracker_deletion_ledger', 'select'), 'authenticated can read its RLS-filtered ledger');
select ok(not has_table_privilege('anon', 'public.tracker_deletion_ledger', 'select'), 'anonymous cannot read the ledger');
select ok(not has_table_privilege('authenticated', 'public.tracker_deletion_ledger', 'insert'), 'authenticated cannot forge ledger rows');
select ok(not has_function_privilege('anon', 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)', 'execute'), 'anonymous cannot permanently delete');
select ok((select not exists(select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') from pg_proc where oid = 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)'::regprocedure), 'PUBLIC cannot permanently delete');
select ok(has_function_privilege('authenticated', 'public.permanently_delete_tracker(uuid,uuid,uuid,bigint)', 'execute'), 'authenticated can request owner-checked permanent deletion');
select ok(has_table_privilege('authenticated', 'public.trackers', 'select'), 'authenticated retains tracker reads');
select ok(not has_table_privilege('authenticated', 'public.trackers', 'update'), 'tracker updates cannot bypass the serialized RPC');
select ok(has_table_privilege('authenticated', 'public.tracker_entries', 'select'), 'authenticated retains tracker-entry reads');
select ok(not has_table_privilege('authenticated', 'public.tracker_entries', 'insert'), 'entry inserts cannot bypass the serialized RPC');
select ok((select convalidated and pg_get_constraintdef(oid) like '%1, 2, 3%' from pg_constraint where conrelid='public.trackers'::regclass and conname='trackers_schema_version_check'), 'permanent deletion preserves tracker schema versions 1 through 3');
select ok(case when to_regclass('cron.job') is null then true else
  (xpath('/table/row/safe/text()', query_to_xml(
    $query$select count(*) = 1 and bool_and(schedule = '17 * * * *' and active
      and command like '%public.purge_expired_tracker_bin()%') as safe
      from cron.job where jobname = 'progress-tracker-bin-cleanup'$query$,
    true, false, '')))[1]::text = 'true'
  end, 'cleanup scheduler is either absent or has exactly the expected inert job');
select is((select enabled from public.tracker_deletion_cleanup_control where id), false, 'cleanup stays inert until operational verification');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000061', 'bin-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000000062', 'bin-owner-two@example.test');
insert into public.trackers (id, user_id, kind, status, name, definition, deleted_at) values
  ('00000000-0000-4000-8000-000000000661', '00000000-0000-4000-8000-000000000061', 'goal', 'active', 'Bin test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000661","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000662', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Expired test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000662","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', now() - interval '31 days'),
  ('00000000-0000-4000-8000-000000000663', '00000000-0000-4000-8000-000000000062', 'goal', 'active', 'Restore test',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000663","kind":"goal","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', null),
  ('00000000-0000-4000-8000-000000000664', '00000000-0000-4000-8000-000000000062', 'habit', 'active', 'Expired stale restore',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000664","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}', now() - interval '31 days');
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values, note, deleted_at) values
  ('00000000-0000-4000-8000-000000000761', '00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000661', '2026-10-09', 'recorded', '{"pages":4}', 'retained until purge', null),
  ('00000000-0000-4000-8000-000000000762', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000662', '2026-10-09', 'recorded', '{"minutes":20}', 'expired content', null),
  ('00000000-0000-4000-8000-000000000763', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000663', '2026-10-09', 'recorded', '{"steps":3}', 'restore history', null),
  ('00000000-0000-4000-8000-000000000764', '00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000664', '2026-10-09', 'recorded', '{"steps":8}', 'expired restore history', null);
insert into public.sync_operation_receipts(user_id, operation_id, entity, expected_revision, record_payload, result) values
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000861', 'tracker', 1,
   '{"id":"00000000-0000-4000-8000-000000000661","definition":{"name":"Bin test"}}', '{"status":"applied"}'),
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000862', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000761","tracker_id":"00000000-0000-4000-8000-000000000661","entry_values":{"pages":4}}', '{"status":"applied"}'),
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000863', 'tracker_entry', 1,
   '{"id":"00000000-0000-4000-8000-000000000661","tracker_id":"00000000-0000-4000-8000-000000000663","entry_values":{"steps":1}}', '{"status":"unrelated"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select throws_ok($$select public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000961','00000000-0000-4000-8000-000000000661',1)$$, '42501', null, 'another account cannot request deletion using the first owner ID');
select is((select count(*) from public.tracker_deletion_ledger), 0::bigint, 'cross-account attempt creates no ledger record');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000961','00000000-0000-4000-8000-000000000661',1)->>'status'), 'deleted'::text, 'owner permanently deletes a tombstoned tracker');
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
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000967','tracker',1,
  '{"id":"00000000-0000-4000-8000-000000000664","schema_version":1,"kind":"habit","status":"active","name":"Expired stale restore","deleted_at":null,"definition":{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000664","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}}')->>'status'), 'permanently_deleted'::text, 'stale restore after 30 days commits permanent deletion before accepting the upload');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000664'), 0::bigint, 'late restore cannot recreate expired tracker content');
select is((select count(*) from public.tracker_deletion_ledger where tracker_id = '00000000-0000-4000-8000-000000000664'), 1::bigint, 'late restore records durable deletion');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000664'), 0::bigint, 'late restore purges associated history');
select ok(pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure) like '%pg_advisory_xact_lock%', 'sync writes serialize by account and tracker');
select ok(pg_get_functiondef('public.permanently_delete_tracker(uuid,uuid,uuid,bigint)'::regprocedure) like '%pg_advisory_xact_lock%', 'manual deletion serializes with sync writes');
select ok(pg_get_functiondef('public.purge_expired_tracker_bin()'::regprocedure) like '%pg_advisory_xact_lock%', 'scheduled cleanup serializes with sync writes');

reset role;
select is(public.purge_expired_tracker_bin(), 0, 'scheduled cleanup is inert before verification');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000662'), 1::bigint, 'expired content is retained while cleanup switch is off');
update public.tracker_deletion_cleanup_control set enabled = true, updated_at = clock_timestamp() where id;
select is(public.purge_expired_tracker_bin(), 1, 'cleanup purges an expired Bin item');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000662'), 0::bigint, 'expired tracker row is purged');
select is((select count(*) from public.tracker_entries where tracker_id = '00000000-0000-4000-8000-000000000662'), 0::bigint, 'expired tracker history is purged');
select is((select count(*) from public.tracker_deletion_ledger where user_id = '00000000-0000-4000-8000-000000000062' and tracker_id = '00000000-0000-4000-8000-000000000662'), 1::bigint, 'scheduled cleanup retains the permanent ledger row');
select is(public.purge_expired_tracker_bin(), 0, 'repeated scheduled cleanup is idempotent');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
select is((public.permanently_delete_tracker('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000966','00000000-0000-4000-8000-000000000663',1)->>'status'), 'conflict'::text, 'stale revision cannot permanently delete a restored tracker');
select is((select deleted_at from public.trackers where id = '00000000-0000-4000-8000-000000000663'), null::timestamptz, 'stale revision leaves restored data unchanged');

reset role;
select * from finish();
rollback;
