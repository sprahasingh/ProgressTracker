begin;
select plan(55);

-- Schema and policy metadata: 19 assertions.
select has_table('public', 'categories', 'categories table exists');
select has_table('public', 'goals', 'goals table exists');
select has_table('public', 'daily_entries', 'daily entries table exists');
select has_table('public', 'daily_journals', 'daily journals table exists');
select has_table('public', 'goal_metrics', 'goal metrics table exists');
select has_table('public', 'goal_progress_logs', 'goal progress logs table exists');
select has_table('public', 'app_settings', 'app settings table exists');

select is((select relrowsecurity from pg_class where oid = 'public.categories'::regclass), true, 'categories has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.goals'::regclass), true, 'goals has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.daily_entries'::regclass), true, 'daily entries has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.daily_journals'::regclass), true, 'daily journals has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.goal_metrics'::regclass), true, 'goal metrics has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.goal_progress_logs'::regclass), true, 'goal progress logs has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass), true, 'app settings has RLS enabled');

select ok((select count(*) = 28 from pg_policies where schemaname = 'public' and tablename in (
  'categories', 'goals', 'daily_entries', 'daily_journals', 'goal_metrics', 'goal_progress_logs', 'app_settings'
)), 'each table has separate select, insert, update, and delete policies');
select ok((select count(*) = 28 from pg_policies where schemaname = 'public' and tablename in (
  'categories', 'goals', 'daily_entries', 'daily_journals', 'goal_metrics', 'goal_progress_logs', 'app_settings'
) and roles @> array['authenticated']::name[]
  and (cmd in ('SELECT', 'DELETE') and coalesce(qual, '') like '%auth.uid()%' or
       cmd = 'INSERT' and coalesce(with_check, '') like '%auth.uid()%' or
       cmd = 'UPDATE' and coalesce(qual, '') like '%auth.uid()%' and coalesce(with_check, '') like '%auth.uid()%')
), 'all policies restrict rows and writes to auth.uid()');
select ok((select count(*) = 4 from pg_constraint where conname in (
  'goals_category_owner_fk', 'daily_entries_category_owner_fk', 'goal_metrics_goal_owner_fk', 'goal_progress_metric_owner_fk'
)), 'all child relationships include user_id in their foreign keys');
select ok((select count(*) = 7 from information_schema.columns where table_schema = 'public'
  and table_name in ('categories', 'goals', 'daily_entries', 'daily_journals', 'goal_metrics', 'goal_progress_logs', 'app_settings')
  and column_name = 'user_id' and is_nullable = 'NO'), 'every table requires an owner');
select is((select count(*) from information_schema.columns where table_schema = 'public'
  and table_name in ('categories', 'goals', 'daily_entries', 'daily_journals', 'goal_metrics', 'goal_progress_logs', 'app_settings')
  and column_name in ('server_changed_at', 'server_revision') and is_nullable = 'NO'), 14::bigint,
  'every table has required server change time and revision fields');

-- Fixed identities and fixtures are rolled back at the end of the test.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'rls-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'rls-owner-two@example.test');

insert into public.categories (id, user_id, name) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'Owner one category'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 'Owner two category');
insert into public.goals (id, user_id, title, category_id, start_date, target_date) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'Owner one goal', '00000000-0000-4000-8000-000000000101', '2026-01-01', '2026-12-31'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000002', 'Owner two goal', '00000000-0000-4000-8000-000000000102', '2026-01-01', '2026-12-31');
insert into public.goal_metrics (id, user_id, goal_id, name, target) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000201', 'Owner one metric', 10),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000202', 'Owner two metric', 10);

-- Anonymous requests have no table privileges and cannot perform any CRUD operation.
set local role anon;
select throws_ok($$select * from public.categories$$, '42501', null, 'anonymous SELECT is denied');
select throws_ok($$insert into public.categories (id, name) values ('00000000-0000-4000-8000-000000000401', 'anon')$$, '42501', null, 'anonymous INSERT is denied');
select throws_ok($$update public.categories set name = 'anon'$$, '42501', null, 'anonymous UPDATE is denied');
select throws_ok($$delete from public.categories$$, '42501', null, 'anonymous DELETE is denied');
reset role;

-- Owner one can access only their own rows and cannot forge ownership or parent references.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select results_eq(
  $$select id from public.categories order by id$$,
  $$values ('00000000-0000-4000-8000-000000000101'::uuid)$$,
  'owner one sees only owner one category'
);
select lives_ok(
  $$insert into public.categories (id, name) values ('00000000-0000-4000-8000-000000000103', 'Owner one inserted')$$,
  'owner one can insert own category using auth.uid() default'
);
select throws_ok(
  $$insert into public.categories (id, user_id, name) values ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000002', 'forged owner')$$,
  '42501', null, 'owner one cannot insert a row for owner two'
);
select throws_ok(
  $$update public.categories set user_id = '00000000-0000-4000-8000-000000000002', server_revision = 1 where id = '00000000-0000-4000-8000-000000000101'$$,
  '42501', null, 'owner one cannot reassign an existing row'
);
select throws_ok(
  $$insert into public.daily_entries (id, category_id, entry_date, status) values ('00000000-0000-4000-8000-000000000411', '00000000-0000-4000-8000-000000000102', '2026-02-01', 'completed')$$,
  '23503', null, 'daily entry cannot reference another owner category'
);
select throws_ok(
  $$insert into public.goals (id, title, category_id, start_date, target_date) values ('00000000-0000-4000-8000-000000000412', 'Cross owner category', '00000000-0000-4000-8000-000000000102', '2026-01-01', '2026-12-31')$$,
  '23503', null, 'goal cannot reference another owner category'
);
select throws_ok(
  $$insert into public.goal_metrics (id, goal_id, name, target) values ('00000000-0000-4000-8000-000000000413', '00000000-0000-4000-8000-000000000202', 'Cross owner goal', 1)$$,
  '23503', null, 'metric cannot reference another owner goal'
);
select throws_ok(
  $$insert into public.goal_progress_logs (id, metric_id, progress_date, value) values ('00000000-0000-4000-8000-000000000414', '00000000-0000-4000-8000-000000000302', '2026-02-01', 1)$$,
  '23503', null, 'progress log cannot reference another owner metric'
);

-- Server revisions provide optimistic concurrency; stale writes raise serialization_failure (40001).
select lives_ok(
  $$insert into public.categories (id, name, server_revision, server_changed_at)
    values ('00000000-0000-4000-8000-000000000101', 'Owner one revised', 1, '2000-01-01T00:00:00Z')
    on conflict (id) do update set name = excluded.name, server_revision = excluded.server_revision,
      server_changed_at = excluded.server_changed_at$$,
  'matching server revision allows a stable-UUID upsert and advances the revision'
);
select ok((select server_changed_at > '2000-01-01T00:00:00Z'::timestamptz
  from public.categories where id = '00000000-0000-4000-8000-000000000101'),
  'server change time cannot be forged by the client');
select throws_ok(
  $$update public.categories set name = 'Stale write', server_revision = 1 where id = '00000000-0000-4000-8000-000000000101'$$,
  '40001', null, 'stale server revision is rejected'
);

-- Owner two can neither read, update, nor delete owner one's row.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
select results_eq(
  $$select id from public.categories order by id$$,
  $$values ('00000000-0000-4000-8000-000000000102'::uuid)$$,
  'owner two sees only owner two category'
);
select results_eq(
  $$update public.categories set name = 'stolen' where id = '00000000-0000-4000-8000-000000000101' returning id$$,
  $$select null::uuid where false$$,
  'owner two UPDATE of owner one row affects no rows'
);
select results_eq(
  $$delete from public.categories where id = '00000000-0000-4000-8000-000000000101' returning id$$,
  $$select null::uuid where false$$,
  'owner two DELETE of owner one row affects no rows'
);

-- Return to owner one to exercise tombstones, uniqueness, restoration and FK retention.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select results_eq(
  $$select name, server_revision from public.categories where id = '00000000-0000-4000-8000-000000000101'$$,
  $$values ('Owner one revised'::text, 2::bigint)$$,
  'other owner attempts did not change owner one row'
);

select lives_ok(
  $$insert into public.daily_entries (id, category_id, entry_date, status) values ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000101', '2026-02-03', 'completed')$$,
  'owner can insert own daily entry'
);
select lives_ok(
  $$update public.daily_entries set deleted_at = now(), server_revision = 1 where id = '00000000-0000-4000-8000-000000000501'$$,
  'daily entry can be soft deleted as a tombstone'
);
select throws_ok(
  $$insert into public.daily_entries (id, category_id, entry_date, status) values ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000101', '2026-02-03', 'completed')$$,
  '23505', null, 'daily entry tombstone reserves its owner/category/date identity'
);
select lives_ok(
  $$update public.daily_entries set deleted_at = null, server_revision = 2 where id = '00000000-0000-4000-8000-000000000501'$$,
  'daily entry can be restored in place with its prior UUID'
);
select results_eq(
  $$select deleted_at is null, server_revision from public.daily_entries where id = '00000000-0000-4000-8000-000000000501'$$,
  $$values (true, 3::bigint)$$,
  'restored daily entry is live and has a new server revision'
);

select lives_ok(
  $$insert into public.daily_journals (id, journal_date, body) values ('00000000-0000-4000-8000-000000000601', '2026-02-03', 'journal')$$,
  'owner can insert own journal'
);
select lives_ok(
  $$update public.daily_journals set deleted_at = now(), server_revision = 1 where id = '00000000-0000-4000-8000-000000000601'$$,
  'journal can be soft deleted as a tombstone'
);
select throws_ok(
  $$insert into public.daily_journals (id, journal_date, body) values ('00000000-0000-4000-8000-000000000602', '2026-02-03', 'duplicate')$$,
  '23505', null, 'journal tombstone reserves its owner/date identity'
);
select lives_ok(
  $$update public.daily_journals set deleted_at = null, server_revision = 2 where id = '00000000-0000-4000-8000-000000000601'$$,
  'journal can be restored in place with its prior UUID'
);
select results_eq(
  $$select deleted_at is null, server_revision from public.daily_journals where id = '00000000-0000-4000-8000-000000000601'$$,
  $$values (true, 3::bigint)$$,
  'restored journal is live and has a new server revision'
);

select lives_ok(
  $$update public.categories set deleted_at = now(), server_revision = 2 where id = '00000000-0000-4000-8000-000000000101'$$,
  'category can be tombstoned while retaining its children'
);
select results_eq(
  $$select deleted_at is not null, server_revision from public.categories where id = '00000000-0000-4000-8000-000000000101'$$,
  $$values (true, 3::bigint)$$,
  'category tombstone remains available for sync and restoration'
);
select lives_ok(
  $$update public.categories set deleted_at = null, server_revision = 3 where id = '00000000-0000-4000-8000-000000000101'$$,
  'category tombstone can be restored in place'
);
select results_eq(
  $$select deleted_at is null, server_revision from public.categories where id = '00000000-0000-4000-8000-000000000101'$$,
  $$values (true, 4::bigint)$$,
  'restored category keeps its UUID and advances revision'
);
select throws_ok(
  $$delete from public.categories where id = '00000000-0000-4000-8000-000000000101'$$,
  '23503', null, 'physical parent deletion is restricted while child history exists'
);

reset role;
select lives_ok(
  $$delete from auth.users where id = '00000000-0000-4000-8000-000000000001'$$,
  'deleting an auth user can cascade through all of that user’s related records'
);
select results_eq(
  $$select count(*) from public.categories where user_id = '00000000-0000-4000-8000-000000000001'
  union all select count(*) from public.goals where user_id = '00000000-0000-4000-8000-000000000001'
  union all select count(*) from public.daily_entries where user_id = '00000000-0000-4000-8000-000000000001'
  union all select count(*) from public.daily_journals where user_id = '00000000-0000-4000-8000-000000000001'
  union all select count(*) from public.goal_metrics where user_id = '00000000-0000-4000-8000-000000000001'
  union all select count(*) from public.goal_progress_logs where user_id = '00000000-0000-4000-8000-000000000001'$$,
  $$values (0::bigint), (0::bigint), (0::bigint), (0::bigint), (0::bigint), (0::bigint)$$,
  'account deletion removes all owned table rows'
);

select * from finish();
rollback;
