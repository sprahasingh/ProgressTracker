begin;
select plan(9);

select is((select confdeltype = 'a'::"char" and condeferrable and condeferred
  from pg_constraint where conrelid='public.goals'::regclass and conname='goals_category_owner_fk'), true,
  'category deletion preserves dependent goals while account deletion defers validation');
select is((select confdeltype = 'a'::"char" and condeferrable and condeferred
  from pg_constraint where conrelid='public.daily_entries'::regclass and conname='daily_entries_category_owner_fk'), true,
  'category deletion preserves daily history');
select is((select confdeltype = 'a'::"char" and condeferrable and condeferred
  from pg_constraint where conrelid='public.goal_metrics'::regclass and conname='goal_metrics_goal_owner_fk'), true,
  'goal deletion preserves its measures');
select is((select confdeltype = 'a'::"char" and condeferrable and condeferred
  from pg_constraint where conrelid='public.goal_progress_logs'::regclass and conname='goal_progress_metric_owner_fk'), true,
  'measure deletion preserves its progress history');
select is((select confdeltype = 'a'::"char" and condeferrable and condeferred
  from pg_constraint where conrelid='public.tracker_entries'::regclass and conname='tracker_entries_tracker_owner_fk'), true,
  'tracker deletion preserves entries outside its trusted permanent-deletion flow');
select is((select count(*) from pg_trigger where not tgisinternal
  and tgfoid = 'public.enforce_owner_parent_reference()'::regprocedure), 5::bigint,
  'all owner-chain relationships have immediate write guards');
select is((select prosecdef from pg_proc where oid='public.enforce_owner_parent_reference()'::regprocedure), true,
  'owner-reference guard can inspect parent rows independently of caller RLS');
select is((select proconfig @> array['search_path=""']::text[] from pg_proc
  where oid='public.enforce_owner_parent_reference()'::regprocedure), true,
  'owner-reference guard pins an empty search path');
select ok(not has_function_privilege('anon','public.enforce_owner_parent_reference()','execute')
  and not has_function_privilege('authenticated','public.enforce_owner_parent_reference()','execute')
  and not exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where p.oid='public.enforce_owner_parent_reference()'::regprocedure
      and acl.grantee=0 and acl.privilege_type='EXECUTE'),
  'owner-reference guard is not executable by API roles or PUBLIC');
select * from finish();
rollback;
