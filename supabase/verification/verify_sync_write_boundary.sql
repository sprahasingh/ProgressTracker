-- Read-only hosted-project preflight for the generic sync write boundary.
-- Run only after both generic tracker and sync write-boundary migrations.
-- Every returned `ok` value must be true before using Sync this account.
with sync_function as (
  select to_regprocedure('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)') as oid
), checks(label, ok) as (
  values
    ('trackers table exists', to_regclass('public.trackers') is not null),
    ('tracker_entries table exists', to_regclass('public.tracker_entries') is not null),
    ('sync_operation_receipts table exists', to_regclass('public.sync_operation_receipts') is not null),
    ('trackers RLS is enabled', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trackers')), false)),
    ('tracker_entries RLS is enabled', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.tracker_entries')), false)),
    ('receipt table RLS is enabled', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.sync_operation_receipts')), false)),
    ('tracker parent foreign key is present and validated', coalesce((select convalidated from pg_constraint where conname = 'tracker_entries_tracker_owner_fk' and conrelid = to_regclass('public.tracker_entries') and contype = 'f'), false)),
    ('sync RPC exists', (select oid is not null from sync_function)),
    ('sync RPC is SECURITY DEFINER', coalesce((select prosecdef from pg_proc where oid = (select oid from sync_function)), false)),
    ('sync RPC pins an empty search path', coalesce((select proconfig @> array['search_path=""']::text[] from pg_proc where oid = (select oid from sync_function)), false)),
    ('authenticated can execute sync RPC', coalesce(has_function_privilege('authenticated', (select oid from sync_function), 'execute'), false)),
    ('anon cannot execute sync RPC', not coalesce(has_function_privilege('anon', (select oid from sync_function), 'execute'), false)),
    ('PUBLIC cannot execute sync RPC', not coalesce((
      select exists (
        select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ) from pg_proc where oid = (select oid from sync_function)
    ), false)),
    ('authenticated has no direct receipt privileges', not (
      coalesce(has_table_privilege('authenticated', to_regclass('public.sync_operation_receipts'), 'select'), false)
      or coalesce(has_table_privilege('authenticated', to_regclass('public.sync_operation_receipts'), 'insert'), false)
      or coalesce(has_table_privilege('authenticated', to_regclass('public.sync_operation_receipts'), 'update'), false)
      or coalesce(has_table_privilege('authenticated', to_regclass('public.sync_operation_receipts'), 'delete'), false)
    )),
    ('anon has no direct receipt privileges', not (
      coalesce(has_table_privilege('anon', to_regclass('public.sync_operation_receipts'), 'select'), false)
      or coalesce(has_table_privilege('anon', to_regclass('public.sync_operation_receipts'), 'insert'), false)
      or coalesce(has_table_privilege('anon', to_regclass('public.sync_operation_receipts'), 'update'), false)
      or coalesce(has_table_privilege('anon', to_regclass('public.sync_operation_receipts'), 'delete'), false)
    ))
)
select label, ok from checks order by label;
