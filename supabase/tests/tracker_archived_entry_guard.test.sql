begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000003101', 'archive-guard@example.test');
insert into public.trackers (id, user_id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000003201', '00000000-0000-4000-8000-000000003101', 'habit', 'active', 'Active', '{"schemaVersion":1,"startDate":"2026-10-10","metrics":[]}'),
  ('00000000-0000-4000-8000-000000003202', '00000000-0000-4000-8000-000000003101', 'habit', 'archived', 'Archived', '{"schemaVersion":1,"startDate":"2026-10-10","metrics":[]}');

select lives_ok($$insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values)
  values ('00000000-0000-4000-8000-000000003301','00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003201','2026-10-10','recorded','{}')$$,
  'active tracker accepts check-ins');
select throws_ok($$insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values)
  values ('00000000-0000-4000-8000-000000003302','00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003202','2026-10-10','recorded','{}')$$,
  '23514', 'Archived trackers cannot receive new or edited check-ins.', 'archived tracker rejects new check-ins');
update public.trackers set status = 'archived' where id = '00000000-0000-4000-8000-000000003201';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000003101';
select throws_ok($$select public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003401','tracker_entry',1,
  '{"id":"00000000-0000-4000-8000-000000003301","tracker_id":"00000000-0000-4000-8000-000000003201","entry_date":"2026-10-10","outcome":"recorded","entry_values":{},"note":"stale client edit","deleted_at":null}'::jsonb)$$,
  '23514', 'Archived trackers cannot receive new or edited check-ins.', 'serialized sync RPC rejects stale edits after archive');
reset role;
select throws_ok($$update public.tracker_entries set note = 'stale update' where id = '00000000-0000-4000-8000-000000003301'$$,
  '23514', 'Archived trackers cannot receive new or edited check-ins.', 'moving a live check-in to an archived tracker is rejected');
select lives_ok($$update public.tracker_entries set deleted_at = clock_timestamp() where id = '00000000-0000-4000-8000-000000003301'$$,
  'entry tombstones remain allowed');
select ok(exists(select 1 from pg_trigger where tgname='tracker_entries_archived_parent_guard' and not tgisinternal), 'archived-parent trigger is installed');

select * from finish();
rollback;
