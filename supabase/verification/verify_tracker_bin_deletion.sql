-- Read-only hosted-project verification for migrations 20261010000100 and
-- 20261011000200_repair_tracker_bin_permanent_deletion.sql.
-- Run after applying the repair and, optionally, the V4 migration.
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
), runtime_catalog as (
  select to_regclass('cron.job') as cron_job_oid,
         to_regclass('cron.job_run_details') as cron_runs_oid,
         to_regclass('public.tracker_deletion_cleanup_control') as control_oid,
         case when to_regclass('cron.job') is not null then query_to_xml(
           $query$select count(*) as job_count,
             coalesce(bool_and(schedule = '17 * * * *' and active
               and command like '%public.purge_expired_tracker_bin()%'), false) as config_ok
             from cron.job where jobname = 'progress-tracker-bin-cleanup'$query$,
           true, false, '') end as cron_job_xml,
         case when to_regclass('cron.job_run_details') is not null and to_regclass('cron.job') is not null then query_to_xml(
           $query$select d.status, d.start_time::text as start_time, d.end_time::text as end_time
             from cron.job_run_details d join cron.job j using (jobid)
             where j.jobname = 'progress-tracker-bin-cleanup'
             order by d.start_time desc limit 1$query$,
           true, false, '') end as cron_run_xml,
         case when to_regclass('public.tracker_deletion_cleanup_control') is not null then query_to_xml(
           'select enabled from public.tracker_deletion_cleanup_control where id', true, false, '') end as control_xml
), runtime_state as (
  select cron_job_oid is not null as cron_job_table_exists,
         cron_runs_oid is not null as cron_runs_table_exists,
         control_oid,
         coalesce(((xpath('/table/row/job_count/text()', cron_job_xml))[1]::text)::integer, 0) as cleanup_job_count,
         coalesce(((xpath('/table/row/config_ok/text()', cron_job_xml))[1]::text)::boolean, false) as cleanup_job_config_ok,
         (xpath('/table/row/status/text()', cron_run_xml))[1]::text as latest_run_status,
         (xpath('/table/row/start_time/text()', cron_run_xml))[1]::text as latest_run_start,
         (xpath('/table/row/end_time/text()', cron_run_xml))[1]::text as latest_run_end,
         coalesce(((xpath('/table/row/enabled/text()', control_xml))[1]::text)::boolean, false) as cleanup_enabled,
         coalesce((select c.relrowsecurity from pg_class c where c.oid = control_oid), false) as control_rls_enabled,
         coalesce(has_table_privilege('anon', control_oid, 'select'), false) as control_anon_select,
         coalesce(has_table_privilege('authenticated', control_oid, 'update'), false) as control_authenticated_update,
         (select pg_get_expr(d.adbin, d.adrelid)
          from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
          where d.adrelid = control_oid and a.attname = 'enabled') as control_enabled_default
  from runtime_catalog
), checks(category, object_name, expected_configuration, actual_configuration, ok) as (
  values
    ('table', 'tracker_deletion_ledger', 'exists; RLS enabled',
      coalesce((select 'exists; RLS=' || c.relrowsecurity::text from ledger l join pg_class c on c.oid = l.oid), 'MISSING'),
      coalesce((select c.relrowsecurity from ledger l join pg_class c on c.oid = l.oid), false)),
    ('policy', 'tracker_deletion_ledger_select_own', 'authenticated SELECT; owner predicate; no other ledger policies',
      coalesce((select format('count=%s; roles=%s; command=%s; using=%s', count(*), min(roles::text), min(cmd), min(qual))
        from pg_policies where schemaname='public' and tablename='tracker_deletion_ledger'), 'count=0'),
      (select count(*) = 1 and bool_and(policyname='tracker_deletion_ledger_select_own' and permissive='PERMISSIVE'
        and roles=array['authenticated']::name[] and cmd='SELECT'
        and regexp_replace(regexp_replace(lower(coalesce(qual,'')), 'as uid', '', 'g'), '[[:space:]()]', '', 'g')
          = 'selectauth.uidisnotnullanduser_id=selectauth.uid')
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
        cleanup_enabled, control_rls_enabled, control_anon_select, control_authenticated_update,
        coalesce(control_enabled_default, 'MISSING')) from runtime_state where control_oid is not null), 'MISSING'),
      coalesce((select control_rls_enabled and not control_anon_select
        and not control_authenticated_update and control_enabled_default='false'
        from runtime_state where control_oid is not null),false)),
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
        position('from public.tracker_deletion_ledger' in lower(p.prosrc))>0
          and position('from public.tracker_deletion_ledger' in lower(p.prosrc))
            < position('from public.sync_operation_receipts' in lower(p.prosrc)))
        from pg_proc p where p.oid=(select oid from sync_rpc)), 'MISSING'),
      coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
        and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
        and position('pg_advisory_xact_lock' in p.prosrc)>0
        and position('from public.tracker_deletion_ledger' in lower(p.prosrc))>0
        and position('from public.tracker_deletion_ledger' in lower(p.prosrc))
          < position('from public.sync_operation_receipts' in lower(p.prosrc))
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
        coalesce(has_table_privilege('authenticated',to_regclass('public.trackers'),'insert'),false),
        coalesce(has_table_privilege('authenticated',to_regclass('public.trackers'),'update'),false),
        coalesce(has_table_privilege('authenticated',to_regclass('public.trackers'),'delete'),false),
        coalesce(has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'insert'),false),
        coalesce(has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'update'),false),
        coalesce(has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'delete'),false)),
      to_regclass('public.trackers') is not null and to_regclass('public.tracker_entries') is not null
        and not has_table_privilege('authenticated',to_regclass('public.trackers'),'insert') and not has_table_privilege('authenticated',to_regclass('public.trackers'),'update')
        and not has_table_privilege('authenticated',to_regclass('public.trackers'),'delete') and not has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'insert')
        and not has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'update') and not has_table_privilege('authenticated',to_regclass('public.tracker_entries'),'delete')),
    ('cron', 'progress-tracker-bin-cleanup', 'cleanup is off; scheduler may be absent, or exactly one known active hourly job may be installed',
      coalesce((select format('cron.job exists=%s; matching job count=%s; correct active schedule and command=%s',
        cron_job_table_exists, cleanup_job_count, cleanup_job_config_ok) from runtime_state), 'MISSING'),
      coalesce((select not cleanup_enabled and (cleanup_job_count=0 or (cron_job_table_exists and cleanup_job_count=1 and cleanup_job_config_ok)) from runtime_state),false)),
    ('cron run', 'progress-tracker-bin-cleanup', 'not required while cleanup is off; required before enabling cleanup',
      coalesce((select format('cron.job_run_details exists=%s; status=%s; start=%s; end=%s',
        cron_runs_table_exists, latest_run_status, latest_run_start, latest_run_end)
        from runtime_state), 'NO RUN RECORDED OR CRON TABLE MISSING'),
      coalesce((select not cleanup_enabled or (cron_runs_table_exists and latest_run_status='succeeded') from runtime_state),false)),
    ('cleanup', 'expiry threshold', 'server routine uses a 30-day server-time threshold and bounded batches',
      coalesce((select format('30-day=%s; batch-limit-500=%s; ledger-retained=%s',
        position('interval ''30 days''' in p.prosrc)>0, position('limit 500' in lower(p.prosrc))>0,
        position('finalize_tracker_deletion' in p.prosrc)>0)
        from pg_proc p where p.oid=(select oid from cleanup_fn)), 'MISSING'),
      coalesce((select position('interval ''30 days''' in p.prosrc)>0 and position('limit 500' in lower(p.prosrc))>0
        and position('finalize_tracker_deletion' in p.prosrc)>0 from pg_proc p where p.oid=(select oid from cleanup_fn)),false))
), overall as (
  select 'OVERALL'::text category, 'repair 20261011000200'::text object_name,
    'all hosted protections pass; scheduled cleanup remains off until separately configured and approved'::text expected_configuration,
    format('%s checks; %s failed',count(*),count(*) filter(where not ok)) actual_configuration,
    coalesce(bool_and(ok),false) ok from checks
)
select category, object_name, expected_configuration, actual_configuration, ok
from (select * from checks union all select * from overall) result
order by case when category='OVERALL' then 1 else 0 end, category, object_name;
