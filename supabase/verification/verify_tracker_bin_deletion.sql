-- Read-only hosted-project verification for migration 20261010000100.
-- Run only after applying the migration in the intended project.
-- This inspects catalog/configuration only. It does not read tracker content or write anything.
with
ledger as (
  select to_regclass('public.tracker_deletion_ledger') as oid
), control as (
  select to_regclass('public.tracker_deletion_cleanup_control') as oid
), delete_rpc as (
  select to_regprocedure('public.permanently_delete_tracker(uuid,uuid,uuid,bigint)') as oid
), sync_rpc as (
  select to_regprocedure('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)') as oid
), cleanup_fn as (
  select to_regprocedure('public.purge_expired_tracker_bin()') as oid
), finalize_fn as (
  select to_regprocedure('public.finalize_tracker_deletion(uuid,uuid,uuid)') as oid
), cleanup_job as (
  select jobid, schedule, command, active
  from cron.job where jobname = 'progress-tracker-bin-cleanup'
), latest_cleanup_run as (
  select d.status, d.start_time, d.end_time, d.return_message
  from cron.job_run_details d join cleanup_job j using (jobid)
  order by d.start_time desc limit 1
), checks(category, object_name, expected_configuration, actual_configuration, ok) as (
  values
    ('table', 'tracker_deletion_ledger', 'exists; RLS enabled',
      coalesce((select 'exists; RLS=' || c.relrowsecurity::text from ledger l join pg_class c on c.oid = l.oid), 'MISSING'),
      coalesce((select c.relrowsecurity from ledger l join pg_class c on c.oid = l.oid), false)),
    ('policy', 'tracker_deletion_ledger_select_own', 'authenticated SELECT; owner predicate; no other ledger policies',
      coalesce((select format('count=%s; roles=%s; command=%s; using=%s', count(*), min(roles::text), min(cmd), min(qual))
        from pg_policies where schemaname='public' and tablename='tracker_deletion_ledger'), 'count=0'),
      (select count(*) = 1 and bool_and(policyname='tracker_deletion_ledger_select_own' and permissive='PERMISSIVE'
        and roles=array['authenticated']::name[] and cmd='SELECT' and qual like '%user_id%' and qual like '%auth.uid()%')
       from pg_policies where schemaname='public' and tablename='tracker_deletion_ledger')),
    ('grant', 'tracker_deletion_ledger', 'authenticated SELECT only; anon has no rights',
      format('authenticated select=%s insert=%s update=%s delete=%s; anon select=%s',
        coalesce(has_table_privilege('authenticated',(select oid from ledger),'select'),false),
        coalesce(has_table_privilege('authenticated',(select oid from ledger),'insert'),false),
        coalesce(has_table_privilege('authenticated',(select oid from ledger),'update'),false),
        coalesce(has_table_privilege('authenticated',(select oid from ledger),'delete'),false),
        coalesce(has_table_privilege('anon',(select oid from ledger),'select'),false)),
      coalesce(has_table_privilege('authenticated',(select oid from ledger),'select')
        and not has_table_privilege('authenticated',(select oid from ledger),'insert')
        and not has_table_privilege('authenticated',(select oid from ledger),'update')
        and not has_table_privilege('authenticated',(select oid from ledger),'delete')
        and not has_table_privilege('anon',(select oid from ledger),'select'),false)),
    ('table', 'tracker_deletion_cleanup_control', 'exists; RLS enabled; no API privileges; migration default=false',
      coalesce((select format('exists; enabled=%s; RLS=%s; anon-select=%s; authenticated-update=%s; default=%s',
        ctl.enabled, c.relrowsecurity, has_table_privilege('anon',c.oid,'select'), has_table_privilege('authenticated',c.oid,'update'),
        pg_get_expr(d.adbin,d.adrelid))
        from public.tracker_deletion_cleanup_control ctl join pg_class c on c.oid=(select oid from control)
        left join pg_attrdef d on d.adrelid=c.oid and d.adnum=(select attnum from pg_attribute where attrelid=c.oid and attname='enabled')
        where ctl.id), 'MISSING'),
      coalesce((select c.relrowsecurity and not has_table_privilege('anon',c.oid,'select')
        and not has_table_privilege('authenticated',c.oid,'update')
        and pg_get_expr(d.adbin,d.adrelid)='false'
        from pg_class c join pg_attrdef d on d.adrelid=c.oid
        join pg_attribute a on a.attrelid=c.oid and a.attnum=d.adnum and a.attname='enabled'
        where c.oid=(select oid from control)),false)),
    ('constraint', 'trackers_schema_version_check', 'validated constraint continues to allow schema v1, v2, and v3',
      coalesce((select pg_get_constraintdef(oid,true) || '; validated=' || convalidated::text
        from pg_constraint where conrelid=to_regclass('public.trackers') and conname='trackers_schema_version_check'),'MISSING'),
      coalesce((select convalidated and pg_get_constraintdef(oid,true) like '%1, 2, 3%'
        from pg_constraint where conrelid=to_regclass('public.trackers') and conname='trackers_schema_version_check'),false)),
    ('RLS', 'trackers and tracker_entries', 'RLS remains enabled on both synchronized tables',
      format('trackers=%s; entries=%s',coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.trackers')),false),
        coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.tracker_entries')),false)),
      coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.trackers')),false)
        and coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.tracker_entries')),false)),
    ('function', 'permanently_delete_tracker', 'SECURITY DEFINER; search_path empty; authenticated EXECUTE; anon/PUBLIC denied',
      coalesce((select format('definer=%s; config=%s; auth=%s; anon=%s; public=%s', p.prosecdef, p.proconfig,
        has_function_privilege('authenticated',p.oid,'execute'), has_function_privilege('anon',p.oid,'execute'),
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)) ) a where a.grantee=0 and a.privilege_type='EXECUTE'))
        from pg_proc p where p.oid=(select oid from delete_rpc)), 'MISSING'),
      coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
        and has_function_privilege('authenticated',p.oid,'execute')
        and not has_function_privilege('anon',p.oid,'execute')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
        from pg_proc p where p.oid=(select oid from delete_rpc)),false)),
    ('function', 'apply_tracker_sync_operation', 'SECURITY DEFINER; search_path empty; authenticated EXECUTE; anon/PUBLIC denied; lock and ledger precede receipt replay',
      coalesce((select format('definer=%s; config=%s; auth=%s; anon=%s; lock=%s; ledger-before-receipt=%s', p.prosecdef, p.proconfig,
        has_function_privilege('authenticated',p.oid,'execute'), has_function_privilege('anon',p.oid,'execute'),
        position('pg_advisory_xact_lock' in p.prosrc)>0,
        position('tracker_deletion_ledger' in p.prosrc)>0 and position('tracker_deletion_ledger' in p.prosrc)<position('sync_operation_receipts' in p.prosrc))
        from pg_proc p where p.oid=(select oid from sync_rpc)), 'MISSING'),
      coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
        and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
        and position('pg_advisory_xact_lock' in p.prosrc)>0
        and position('tracker_deletion_ledger' in p.prosrc)>0
        and position('tracker_deletion_ledger' in p.prosrc)<position('sync_operation_receipts' in p.prosrc)
        from pg_proc p where p.oid=(select oid from sync_rpc)),false)),
    ('function', 'finalize_tracker_deletion', 'internal SECURITY DEFINER; search_path empty; no API execute',
      coalesce((select format('definer=%s; config=%s; anon=%s; authenticated=%s',p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'execute'),has_function_privilege('authenticated',p.oid,'execute'))
        from pg_proc p where p.oid=(select oid from finalize_fn)), 'MISSING'),
      coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
        and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
        from pg_proc p where p.oid=(select oid from finalize_fn)),false)),
    ('function', 'purge_expired_tracker_bin', 'internal SECURITY DEFINER; search_path empty; no API execute',
      coalesce((select format('definer=%s; config=%s; anon=%s; authenticated=%s',p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'execute'),has_function_privilege('authenticated',p.oid,'execute'))
        from pg_proc p where p.oid=(select oid from cleanup_fn)), 'MISSING'),
      coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
        and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
        from pg_proc p where p.oid=(select oid from cleanup_fn)),false)),
    ('grant', 'trackers and tracker_entries', 'authenticated SELECT only; direct client writes denied',
      format('trackers insert/update/delete=%s/%s/%s; entries insert/update/delete=%s/%s/%s',
        coalesce(has_table_privilege('authenticated','public.trackers','insert'),false),
        coalesce(has_table_privilege('authenticated','public.trackers','update'),false),
        coalesce(has_table_privilege('authenticated','public.trackers','delete'),false),
        coalesce(has_table_privilege('authenticated','public.tracker_entries','insert'),false),
        coalesce(has_table_privilege('authenticated','public.tracker_entries','update'),false),
        coalesce(has_table_privilege('authenticated','public.tracker_entries','delete'),false)),
      not has_table_privilege('authenticated','public.trackers','insert') and not has_table_privilege('authenticated','public.trackers','update')
        and not has_table_privilege('authenticated','public.trackers','delete') and not has_table_privilege('authenticated','public.tracker_entries','insert')
        and not has_table_privilege('authenticated','public.tracker_entries','update') and not has_table_privilege('authenticated','public.tracker_entries','delete')),
    ('cron', 'progress-tracker-bin-cleanup', 'one active hourly job at minute 17 invokes cleanup RPC',
      coalesce((select format('count=%s; schedule=%s; active=%s; command=%s',(select count(*) from cleanup_job),schedule,active,command) from cleanup_job limit 1),'MISSING'),
      (select count(*)=1 and bool_and(schedule='17 * * * *' and active and command like '%public.purge_expired_tracker_bin()%') from cleanup_job)),
    ('cron run', 'progress-tracker-bin-cleanup', 'at least one successful scheduled execution',
      coalesce((select format('status=%s; start=%s; end=%s; result=%s',status,start_time,end_time,return_message) from latest_cleanup_run),'NO RUN RECORDED'),
      coalesce((select status='succeeded' from latest_cleanup_run),false)),
    ('cleanup', 'expiry threshold', 'server routine uses a 30-day server-time threshold and bounded batches',
      coalesce((select format('30-day=%s; batch-limit-500=%s; ledger-retained=%s',
        position('interval ''30 days''' in p.prosrc)>0, position('limit 500' in lower(p.prosrc))>0,
        position('finalize_tracker_deletion' in p.prosrc)>0)
        from pg_proc p where p.oid=(select oid from cleanup_fn)), 'MISSING'),
      coalesce((select position('interval ''30 days''' in p.prosrc)>0 and position('limit 500' in lower(p.prosrc))>0
        and position('finalize_tracker_deletion' in p.prosrc)>0 from pg_proc p where p.oid=(select oid from cleanup_fn)),false))
), overall as (
  select 'OVERALL'::text category, 'migration 20261010000100'::text object_name,
    'all required hosted checks pass; cleanup switch remains off until operator enables it'::text expected_configuration,
    format('%s checks; %s failed',count(*),count(*) filter(where not ok)) actual_configuration,
    coalesce(bool_and(ok),false) ok from checks
)
select category, object_name, expected_configuration, actual_configuration, ok
from (select * from checks union all select * from overall) result
order by case when category='OVERALL' then 1 else 0 end, category, object_name;
