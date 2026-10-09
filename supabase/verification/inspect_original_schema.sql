-- Read-only, single-result verification of migration 20261008000100.
-- Run this complete file in the intended Supabase project's SQL Editor.
-- It reads PostgreSQL catalogs only. It does not read application rows or write data/schema.
begin transaction read only;

with
expected_tables(table_name) as (
  values ('categories'), ('goals'), ('daily_entries'), ('daily_journals'),
         ('goal_metrics'), ('goal_progress_logs'), ('app_settings')
),
expected_columns(table_name, column_name, type_name, not_null) as (
  values
    ('categories','id','uuid',true), ('categories','user_id','uuid',true),
    ('categories','name','text',true), ('categories','icon','text',true),
    ('categories','description','text',false), ('categories','accent','text',true),
    ('categories','schedule','jsonb',true), ('categories','position','integer',true),
    ('categories','created_at','timestamp with time zone',true), ('categories','updated_at','timestamp with time zone',true),
    ('categories','server_changed_at','timestamp with time zone',true), ('categories','server_revision','bigint',true),
    ('categories','archived_at','timestamp with time zone',false), ('categories','deleted_at','timestamp with time zone',false),
    ('goals','id','uuid',true), ('goals','user_id','uuid',true), ('goals','title','text',true),
    ('goals','description','text',true), ('goals','category_id','uuid',false),
    ('goals','start_date','date',true), ('goals','target_date','date',true), ('goals','status','text',true),
    ('goals','completed_at','timestamp with time zone',false), ('goals','created_at','timestamp with time zone',true),
    ('goals','updated_at','timestamp with time zone',true), ('goals','server_changed_at','timestamp with time zone',true),
    ('goals','server_revision','bigint',true), ('goals','deleted_at','timestamp with time zone',false),
    ('daily_entries','id','uuid',true), ('daily_entries','user_id','uuid',true),
    ('daily_entries','category_id','uuid',true), ('daily_entries','entry_date','date',true),
    ('daily_entries','status','text',true), ('daily_entries','note','text',true),
    ('daily_entries','created_at','timestamp with time zone',true), ('daily_entries','updated_at','timestamp with time zone',true),
    ('daily_entries','server_changed_at','timestamp with time zone',true), ('daily_entries','server_revision','bigint',true),
    ('daily_entries','deleted_at','timestamp with time zone',false),
    ('daily_journals','id','uuid',true), ('daily_journals','user_id','uuid',true),
    ('daily_journals','journal_date','date',true), ('daily_journals','body','text',true),
    ('daily_journals','created_at','timestamp with time zone',true), ('daily_journals','updated_at','timestamp with time zone',true),
    ('daily_journals','server_changed_at','timestamp with time zone',true), ('daily_journals','server_revision','bigint',true),
    ('daily_journals','deleted_at','timestamp with time zone',false),
    ('goal_metrics','id','uuid',true), ('goal_metrics','user_id','uuid',true), ('goal_metrics','goal_id','uuid',true),
    ('goal_metrics','name','text',true), ('goal_metrics','unit','text',true), ('goal_metrics','target','numeric',true),
    ('goal_metrics','weight','numeric',false), ('goal_metrics','position','integer',true),
    ('goal_metrics','created_at','timestamp with time zone',true), ('goal_metrics','updated_at','timestamp with time zone',true),
    ('goal_metrics','server_changed_at','timestamp with time zone',true), ('goal_metrics','server_revision','bigint',true),
    ('goal_metrics','deleted_at','timestamp with time zone',false),
    ('goal_progress_logs','id','uuid',true), ('goal_progress_logs','user_id','uuid',true),
    ('goal_progress_logs','metric_id','uuid',true), ('goal_progress_logs','progress_date','date',true),
    ('goal_progress_logs','value','numeric',true), ('goal_progress_logs','recorded_at','timestamp with time zone',true),
    ('goal_progress_logs','updated_at','timestamp with time zone',true),
    ('goal_progress_logs','server_changed_at','timestamp with time zone',true),
    ('goal_progress_logs','server_revision','bigint',true), ('goal_progress_logs','deleted_at','timestamp with time zone',false),
    ('goal_progress_logs','note','text',false),
    ('app_settings','id','text',true), ('app_settings','user_id','uuid',true), ('app_settings','timezone','text',true),
    ('app_settings','appearance','text',true), ('app_settings','backup_reminder_days','integer',false),
    ('app_settings','updated_at','timestamp with time zone',true),
    ('app_settings','server_changed_at','timestamp with time zone',true), ('app_settings','server_revision','bigint',true)
),
expected_defaults(table_name, column_name, default_sql) as (
  values
    ('categories','user_id','auth.uid()'), ('categories','icon','''''::text'), ('categories','accent','''''::text'),
    ('categories','schedule','''{"kind": "every-day"}''::jsonb'), ('categories','position','0'),
    ('categories','created_at','now()'), ('categories','updated_at','now()'),
    ('categories','server_changed_at','clock_timestamp()'), ('categories','server_revision','1'),
    ('goals','user_id','auth.uid()'), ('goals','description','''''::text'), ('goals','status','''active''::text'),
    ('goals','created_at','now()'), ('goals','updated_at','now()'), ('goals','server_changed_at','clock_timestamp()'), ('goals','server_revision','1'),
    ('daily_entries','user_id','auth.uid()'), ('daily_entries','note','''''::text'),
    ('daily_entries','created_at','now()'), ('daily_entries','updated_at','now()'),
    ('daily_entries','server_changed_at','clock_timestamp()'), ('daily_entries','server_revision','1'),
    ('daily_journals','user_id','auth.uid()'), ('daily_journals','body','''''::text'),
    ('daily_journals','created_at','now()'), ('daily_journals','updated_at','now()'),
    ('daily_journals','server_changed_at','clock_timestamp()'), ('daily_journals','server_revision','1'),
    ('goal_metrics','user_id','auth.uid()'), ('goal_metrics','unit','''''::text'), ('goal_metrics','position','0'),
    ('goal_metrics','created_at','now()'), ('goal_metrics','updated_at','now()'),
    ('goal_metrics','server_changed_at','clock_timestamp()'), ('goal_metrics','server_revision','1'),
    ('goal_progress_logs','user_id','auth.uid()'), ('goal_progress_logs','recorded_at','now()'),
    ('goal_progress_logs','updated_at','now()'), ('goal_progress_logs','server_changed_at','clock_timestamp()'), ('goal_progress_logs','server_revision','1'),
    ('app_settings','id','''general''::text'), ('app_settings','user_id','auth.uid()'),
    ('app_settings','timezone','''UTC''::text'), ('app_settings','appearance','''system''::text'),
    ('app_settings','updated_at','now()'), ('app_settings','server_changed_at','clock_timestamp()'), ('app_settings','server_revision','1')
),
actual_columns as (
  select c.relname as table_name, a.attname as column_name,
         format_type(a.atttypid, a.atttypmod) as type_name,
         a.attnotnull as not_null,
         pg_get_expr(d.adbin, d.adrelid) as default_expression
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
),
expected_constraints(table_name, constraint_name, constraint_type, key_columns, ref_table, ref_columns, delete_action, is_deferrable, check_expression) as (
  values
    ('categories','categories_pkey','p',array['id']::text[],null::text,null::text[],null::text,false,null::text),
    ('categories','categories_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('categories','categories_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('categories','categories_name_check','c',null,null,null,null,false,'char_length(btrim(name)) >= 1 AND char_length(btrim(name)) <= 120'),
    ('categories','categories_schedule_check','c',null,null,null,null,false,'jsonb_typeof(schedule) = ''object'' AND schedule ? ''kind'''),
    ('categories','categories_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('goals','goals_pkey','p',array['id'],null,null,null,false,null),
    ('goals','goals_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('goals','goals_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('goals','goals_title_check','c',null,null,null,null,false,'char_length(btrim(title)) >= 1 AND char_length(btrim(title)) <= 200'),
    ('goals','goals_status_check','c',null,null,null,null,false,'status = ANY (ARRAY[''active'', ''paused'', ''completed'', ''archived''])'),
    ('goals','goals_date_order','c',null,null,null,null,false,'target_date >= start_date'),
    ('goals','goals_category_owner_fk','f',array['user_id','category_id'],'public.categories',array['user_id','id'],'a',true,null),
    ('goals','goals_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('daily_entries','daily_entries_pkey','p',array['id'],null,null,null,false,null),
    ('daily_entries','daily_entries_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('daily_entries','daily_entries_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('daily_entries','daily_entries_user_id_category_id_entry_date_key','u',array['user_id','category_id','entry_date'],null,null,null,false,null),
    ('daily_entries','daily_entries_status_check','c',null,null,null,null,false,'status = ANY (ARRAY[''completed'', ''skipped''])'),
    ('daily_entries','daily_entries_category_owner_fk','f',array['user_id','category_id'],'public.categories',array['user_id','id'],'a',true,null),
    ('daily_entries','daily_entries_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('daily_journals','daily_journals_pkey','p',array['id'],null,null,null,false,null),
    ('daily_journals','daily_journals_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('daily_journals','daily_journals_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('daily_journals','daily_journals_user_id_journal_date_key','u',array['user_id','journal_date'],null,null,null,false,null),
    ('daily_journals','daily_journals_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('goal_metrics','goal_metrics_pkey','p',array['id'],null,null,null,false,null),
    ('goal_metrics','goal_metrics_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('goal_metrics','goal_metrics_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('goal_metrics','goal_metrics_name_check','c',null,null,null,null,false,'char_length(btrim(name)) >= 1 AND char_length(btrim(name)) <= 120'),
    ('goal_metrics','goal_metrics_target_check','c',null,null,null,null,false,'target > 0 AND target < ''Infinity''::numeric'),
    ('goal_metrics','goal_metrics_weight_check','c',null,null,null,null,false,'weight IS NULL OR (weight >= 0 AND weight < ''Infinity''::numeric)'),
    ('goal_metrics','goal_metrics_goal_owner_fk','f',array['user_id','goal_id'],'public.goals',array['user_id','id'],'a',true,null),
    ('goal_metrics','goal_metrics_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('goal_progress_logs','goal_progress_logs_pkey','p',array['id'],null,null,null,false,null),
    ('goal_progress_logs','goal_progress_logs_user_id_id_key','u',array['user_id','id'],null,null,null,false,null),
    ('goal_progress_logs','goal_progress_logs_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('goal_progress_logs','goal_progress_logs_value_check','c',null,null,null,null,false,'value >= 0 AND value < ''Infinity''::numeric'),
    ('goal_progress_logs','goal_progress_metric_owner_fk','f',array['user_id','metric_id'],'public.goal_metrics',array['user_id','id'],'a',true,null),
    ('goal_progress_logs','goal_progress_logs_server_revision_check','c',null,null,null,null,false,'server_revision > 0'),
    ('app_settings','app_settings_pkey','p',array['user_id'],null,null,null,false,null),
    ('app_settings','app_settings_user_id_fkey','f',array['user_id'],'auth.users',array['id'],'c',false,null),
    ('app_settings','app_settings_id_check','c',null,null,null,null,false,'id = ''general'''),
    ('app_settings','app_settings_appearance_check','c',null,null,null,null,false,'appearance = ANY (ARRAY[''light'', ''dark'', ''system''])'),
    ('app_settings','app_settings_backup_reminder_days_check','c',null,null,null,null,false,'backup_reminder_days IS NULL OR backup_reminder_days > 0'),
    ('app_settings','app_settings_server_revision_check','c',null,null,null,null,false,'server_revision > 0')
),
actual_constraints as (
  select t.relname as table_name, c.conname as constraint_name, c.contype::text as constraint_type,
         (select array_agg(a.attname::text order by x.ord)
          from unnest(c.conkey) with ordinality x(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = x.attnum) as key_columns,
         case when rt.oid is null then null else rns.nspname || '.' || rt.relname end as ref_table,
         (select array_agg(a.attname::text order by x.ord)
          from unnest(c.confkey) with ordinality x(attnum, ord)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = x.attnum) as ref_columns,
         case when c.contype = 'f' then c.confdeltype::text end as delete_action,
         case when c.contype = 'f' then c.confupdtype::text end as update_action,
         case when c.contype = 'f' then c.confmatchtype::text end as match_type,
         c.condeferrable as is_deferrable, c.condeferred as initially_deferred,
         pg_get_expr(c.conbin, c.conrelid) as check_expression,
         c.convalidated as validated, pg_get_constraintdef(c.oid, true) as definition
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  left join pg_class rt on rt.oid = c.confrelid
  left join pg_namespace rns on rns.oid = rt.relnamespace
  where n.nspname = 'public'
    and t.relname in (select table_name from expected_tables)
),
expected_indexes(table_name, index_name, key_columns, is_unique, is_primary) as (
  values
    ('categories','categories_pkey',array['id']::text[],true,true), ('categories','categories_user_id_id_key',array['user_id','id'],true,false),
    ('goals','goals_pkey',array['id'],true,true), ('goals','goals_user_id_id_key',array['user_id','id'],true,false),
    ('daily_entries','daily_entries_pkey',array['id'],true,true), ('daily_entries','daily_entries_user_id_id_key',array['user_id','id'],true,false),
    ('daily_entries','daily_entries_user_id_category_id_entry_date_key',array['user_id','category_id','entry_date'],true,false),
    ('daily_journals','daily_journals_pkey',array['id'],true,true), ('daily_journals','daily_journals_user_id_id_key',array['user_id','id'],true,false),
    ('daily_journals','daily_journals_user_id_journal_date_key',array['user_id','journal_date'],true,false),
    ('goal_metrics','goal_metrics_pkey',array['id'],true,true), ('goal_metrics','goal_metrics_user_id_id_key',array['user_id','id'],true,false),
    ('goal_progress_logs','goal_progress_logs_pkey',array['id'],true,true), ('goal_progress_logs','goal_progress_logs_user_id_id_key',array['user_id','id'],true,false),
    ('app_settings','app_settings_pkey',array['user_id'],true,true),
    ('categories','categories_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('goals','goals_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('goals','goals_user_category_idx',array['user_id','category_id'],false,false),
    ('daily_entries','daily_entries_user_date_idx',array['user_id','entry_date'],false,false),
    ('daily_entries','daily_entries_category_fk_idx',array['user_id','category_id'],false,false),
    ('daily_entries','daily_entries_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('daily_journals','daily_journals_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('goal_metrics','goal_metrics_user_goal_idx',array['user_id','goal_id'],false,false),
    ('goal_metrics','goal_metrics_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('goal_progress_logs','goal_progress_user_metric_date_idx',array['user_id','metric_id','progress_date'],false,false),
    ('goal_progress_logs','goal_progress_user_server_changed_idx',array['user_id','server_changed_at'],false,false),
    ('app_settings','app_settings_user_server_changed_idx',array['user_id','server_changed_at'],false,false)
),
actual_indexes as (
  select t.relname as table_name, i.relname as index_name,
         array(select a.attname::text from unnest(ix.indkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
               where k.ord <= ix.indnkeyatts order by k.ord) as key_columns,
         ix.indisunique as is_unique, ix.indisprimary as is_primary,
         am.amname as method, ix.indisvalid as valid, ix.indisready as ready,
         ix.indexprs is null as no_expressions, ix.indpred is null as no_predicate,
         pg_get_indexdef(ix.indexrelid) as definition
  from pg_index ix join pg_class t on t.oid = ix.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_class i on i.oid = ix.indexrelid
  join pg_am am on am.oid = i.relam
  where n.nspname = 'public' and t.relname in (select table_name from expected_tables)
),
expected_policies(table_name, policy_name, command, using_expression, check_expression) as (
  select t.table_name, t.table_name || '_' || o.suffix || '_own', o.command,
         case when o.command in ('SELECT','UPDATE','DELETE') then
           '((select auth.uid()) is not null and user_id = (select auth.uid()))' else null end,
         case when o.command in ('INSERT','UPDATE') then
           '((select auth.uid()) is not null and user_id = (select auth.uid())' ||
           case when t.table_name = 'app_settings' then ' and id = ''general''' else '' end || ')'
           else null end
  from expected_tables t
  cross join (values ('select','SELECT'),('insert','INSERT'),('update','UPDATE'),('delete','DELETE')) o(suffix,command)
),
actual_policies as (
  select schemaname, tablename as table_name, policyname as policy_name, permissive,
         roles, cmd as command, qual as using_expression, with_check as check_expression
  from pg_policies where schemaname = 'public'
    and tablename in (select table_name from expected_tables)
),
expected_privileges(table_name, role_name, privilege_name, allowed) as (
  select t.table_name, r.role_name, p.privilege_name,
         r.role_name = 'authenticated' and p.privilege_name in ('SELECT','INSERT','UPDATE','DELETE')
  from expected_tables t
  cross join (values ('anon'),('authenticated')) r(role_name)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege_name)
),
expected_triggers(table_name, trigger_name, args) as (
  values ('categories','categories_server_revision',''::bytea), ('goals','goals_server_revision',''::bytea),
    ('daily_entries','daily_entries_server_revision',''::bytea), ('daily_journals','daily_journals_server_revision',''::bytea),
    ('goal_metrics','goal_metrics_server_revision',''::bytea), ('goal_progress_logs','goal_progress_logs_server_revision',''::bytea),
    ('app_settings','app_settings_server_revision',convert_to('user_id','UTF8') || decode('00','hex'))
),
actual_triggers as (
  select c.relname as table_name, tr.tgname as trigger_name, tr.tgtype, tr.tgargs,
         pn.nspname as function_schema, p.proname as function_name,
         pg_get_triggerdef(tr.oid, true) as definition
  from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = tr.tgfoid
  join pg_namespace pn on pn.oid = p.pronamespace
  where n.nspname = 'public' and not tr.tgisinternal
    and c.relname in (select table_name from expected_tables)
),
function_info as (
  select p.*, l.lanname, pg_get_function_result(p.oid) as result_type,
         md5(p.prosrc) as source_md5,
         has_function_privilege('anon', p.oid, 'execute') as anon_execute,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'bump_server_revision' and p.pronargs = 0
),
checks(category, object_name, expected_configuration, actual_configuration, ok) as (
  -- Relation existence and RLS flags.
  select 'table', e.table_name, 'ordinary table; RLS enabled; FORCE RLS disabled',
         coalesce(format('relkind=%s; RLS=%s; FORCE RLS=%s', c.relkind, c.relrowsecurity, c.relforcerowsecurity), 'MISSING'),
         coalesce(c.relkind = 'r' and c.relrowsecurity and not c.relforcerowsecurity, false)
  from expected_tables e left join pg_class c on c.oid = to_regclass('public.' || e.table_name)
  union all
  -- Every expected column; missing and extra columns become explicit failures.
  select 'column', e.table_name || '.' || e.column_name,
         e.type_name || case when e.not_null then ' NOT NULL' else ' NULL allowed' end,
         coalesce(a.type_name || case when a.not_null then ' NOT NULL' else ' NULL allowed' end ||
           '; default=' || coalesce(a.default_expression, '<none>'), 'MISSING'),
  coalesce(a.type_name = e.type_name and a.not_null = e.not_null, false)
  from expected_columns e left join actual_columns a using (table_name,column_name)
  union all
  select 'column default', e.table_name || '.' || e.column_name,
         coalesce(d.default_sql, '<none>'), coalesce(a.default_expression, '<none>'),
         coalesce(case when a.column_name is null then false
           when d.default_sql is null then a.default_expression is null
           else regexp_replace(regexp_replace(lower(a.default_expression), '::(text|jsonb)', '', 'g'), '[[:space:]()]', '', 'g')
             = regexp_replace(regexp_replace(lower(d.default_sql), '::(text|jsonb)', '', 'g'), '[[:space:]()]', '', 'g') end
           , false)
  from expected_columns e
  left join expected_defaults d using (table_name,column_name)
  left join actual_columns a using (table_name,column_name)
  union all
  select 'unexpected column', a.table_name || '.' || a.column_name, 'no additional column',
         a.type_name || case when a.not_null then ' NOT NULL' else ' NULL allowed' end, false
  from actual_columns a join expected_tables t using (table_name)
  left join expected_columns e using (table_name,column_name) where e.column_name is null
  union all
  -- Constraint semantics are compared by key columns, referenced columns/action,
  -- deferrability and normalized parsed CHECK expression, not merely by counts.
  select 'constraint', e.table_name || '.' || e.constraint_name,
         format('type=%s; columns=%s; ref=%s(%s); FK update_action=a/match=s when type=f; delete_action=%s; deferrable=%s initially_deferred=false; check=%s',
           e.constraint_type, case when e.constraint_type = 'c' then '<checked by expression>' else coalesce(e.key_columns::text,'-') end, coalesce(e.ref_table,'-'),
           coalesce(e.ref_columns::text,'-'), coalesce(e.delete_action,'-'), e.is_deferrable,
           coalesce(e.check_expression,'-')),
         coalesce(format('type=%s; columns=%s; ref=%s(%s); update_action=%s; match=%s; delete_action=%s; deferrable=%s initially_deferred=%s; check=%s; validated=%s; definition=%s',
           a.constraint_type, coalesce(a.key_columns::text,'-'), coalesce(a.ref_table,'-'),
           coalesce(a.ref_columns::text,'-'), coalesce(a.update_action,'-'), coalesce(a.match_type,'-'),
           coalesce(a.delete_action,'-'), a.is_deferrable, a.initially_deferred,
           coalesce(a.check_expression,'-'), a.validated, a.definition), 'MISSING'),
         coalesce(a.constraint_type = e.constraint_type
           and (e.constraint_type = 'c' or a.key_columns is not distinct from e.key_columns)
           and a.ref_table is not distinct from e.ref_table and a.ref_columns is not distinct from e.ref_columns
           and a.delete_action is not distinct from e.delete_action and a.is_deferrable = e.is_deferrable
           and (a.constraint_type <> 'f' or (a.update_action = 'a' and a.match_type = 's'))
           and not a.initially_deferred and a.validated and
           (e.check_expression is null or
             regexp_replace(regexp_replace(lower(a.check_expression), '::(text|numeric)', '', 'g'), '[[:space:]()]', '', 'g') =
             regexp_replace(regexp_replace(lower(e.check_expression), '::(text|numeric)', '', 'g'), '[[:space:]()]', '', 'g')), false)
  from expected_constraints e left join actual_constraints a
    on a.table_name = e.table_name and a.constraint_name = e.constraint_name
  union all
  select 'unexpected constraint', a.table_name || '.' || a.constraint_name,
         'no extra constraint; an additional server_revision > 0 CHECK is an allowed safeguard', a.definition,
         coalesce(a.constraint_type = 'c' and
           regexp_replace(regexp_replace(lower(a.check_expression), '::(text|numeric)', '', 'g'), '[[:space:]()]', '', 'g') = 'server_revision>0', false)
  from actual_constraints a left join expected_constraints e
    on e.table_name = a.table_name and e.constraint_name = a.constraint_name
  where e.constraint_name is null
  union all
  -- Compare all indexes by name, key order, method and unique/primary semantics.
  select 'index', e.table_name || '.' || e.index_name,
         format('btree %s; unique=%s; primary=%s', e.key_columns, e.is_unique, e.is_primary),
         coalesce(format('%s %s; unique=%s; primary=%s; valid=%s; ready=%s; expression-free=%s; predicate-free=%s; %s',
           a.method, a.key_columns, a.is_unique, a.is_primary, a.valid, a.ready, a.no_expressions, a.no_predicate, a.definition), 'MISSING'),
         coalesce(a.key_columns = e.key_columns and a.method = 'btree' and a.is_unique = e.is_unique
           and a.is_primary = e.is_primary and a.valid and a.ready and a.no_expressions and a.no_predicate, false)
  from expected_indexes e left join actual_indexes a using (table_name,index_name)
  union all
  select 'unexpected index', a.table_name || '.' || a.index_name, 'no additional index', a.definition, false
  from actual_indexes a left join expected_indexes e using (table_name,index_name) where e.index_name is null
  union all
  -- Exact policy inventory and normalized owner predicates, including settings id guard.
  select 'RLS policy', e.table_name || '.' || e.policy_name,
         format('PERMISSIVE TO authenticated FOR %s; USING=%s; WITH CHECK=%s', e.command,
           coalesce(e.using_expression,'-'), coalesce(e.check_expression,'-')),
         coalesce(format('%s TO %s FOR %s; USING=%s; WITH CHECK=%s', a.permissive, a.roles, a.command,
           coalesce(a.using_expression,'-'), coalesce(a.check_expression,'-')), 'MISSING'),
         coalesce(a.permissive = 'PERMISSIVE' and a.roles = array['authenticated']::name[] and a.command = e.command
           and regexp_replace(regexp_replace(regexp_replace(lower(coalesce(a.using_expression,'')), 'as uid', '', 'g'), '::text', '', 'g'), '[[:space:]()]', '', 'g')
             = regexp_replace(lower(coalesce(e.using_expression,'')), '[[:space:]()]', '', 'g')
           and regexp_replace(regexp_replace(regexp_replace(lower(coalesce(a.check_expression,'')), 'as uid', '', 'g'), '::text', '', 'g'), '[[:space:]()]', '', 'g')
             = regexp_replace(lower(coalesce(e.check_expression,'')), '[[:space:]()]', '', 'g'), false)
  from expected_policies e left join actual_policies a using (table_name,policy_name)
  union all
  select 'unexpected RLS policy', a.table_name || '.' || a.policy_name,
         'no additional policy', format('%s FOR %s USING=%s WITH CHECK=%s',a.roles,a.command,a.using_expression,a.check_expression), false
  from actual_policies a left join expected_policies e using (table_name,policy_name) where e.policy_name is null
  union all
  -- Check effective API-role rights, including dangerous TRUNCATE/REFERENCES/TRIGGER.
  select 'table privilege', e.table_name || '.' || e.role_name || '.' || lower(e.privilege_name),
         'allowed=' || e.allowed::text,
         'allowed=' || coalesce(has_table_privilege(e.role_name, to_regclass('public.' || e.table_name), e.privilege_name), false)::text,
         coalesce(to_regclass('public.' || e.table_name) is not null and
           has_table_privilege(e.role_name, to_regclass('public.' || e.table_name), e.privilege_name) = e.allowed, false)
  from expected_privileges e
  union all
  -- BEFORE INSERT OR UPDATE FOR EACH ROW is tgtype 23. Settings alone passes user_id.
  select 'revision trigger', e.table_name || '.' || e.trigger_name,
         'BEFORE INSERT OR UPDATE FOR EACH ROW; public.bump_server_revision(); args=' ||
           case when e.args = ''::bytea then '<none>' else 'user_id' end,
         coalesce(format('tgtype=%s; function=%s.%s; args_hex=%s; %s', a.tgtype, a.function_schema, a.function_name,
           encode(a.tgargs,'hex'), a.definition), 'MISSING'),
         coalesce(a.tgtype = 23 and a.function_schema = 'public' and a.function_name = 'bump_server_revision'
           and a.tgargs = e.args, false)
  from expected_triggers e left join actual_triggers a using (table_name,trigger_name)
  union all
  select 'unexpected trigger', a.table_name || '.' || a.trigger_name,
         'no additional user trigger', a.definition, false
  from actual_triggers a left join expected_triggers e using (table_name,trigger_name) where e.trigger_name is null
  union all
  -- Shared trigger function: exact source hash plus execution/security configuration.
  select 'revision function', 'public.bump_server_revision()',
         'plpgsql; RETURNS trigger; invoker; search_path=""; source md5=a3589ecf878ced8a43ef2b3dda8c6ad8; no anon/authenticated execution',
         coalesce(format('%s; RETURNS %s; security_definer=%s; settings=%s; source_md5=%s; anon_execute=%s; authenticated_execute=%s',
           f.lanname, f.result_type, f.prosecdef, f.proconfig, f.source_md5, f.anon_execute, f.authenticated_execute), 'MISSING'),
         coalesce(f.lanname = 'plpgsql' and f.result_type = 'trigger' and not f.prosecdef
           and f.proconfig = array['search_path=""']::text[]
           and f.source_md5 = 'a3589ecf878ced8a43ef2b3dda8c6ad8'
           and not f.anon_execute and not f.authenticated_execute, false)
  from (values (1)) seed(n) left join function_info f on true
),
classified_checks as (
  select c.*,
         case
           when c.category = 'unexpected constraint' and c.ok then 'safe additional safeguard'
           when not c.ok then 'genuine mismatch requiring intervention'
           when c.category = 'RLS policy' then 'semantically equivalent difference'
           when c.category = 'constraint' and position('check=-' in c.expected_configuration) = 0
             then 'semantically equivalent difference'
           else 'exact match'
         end::text as classification
  from checks c
),
overall as (
  select 'OVERALL'::text as category, 'migration 20261008000100'::text as object_name,
         case when not coalesce(bool_and(ok), false) then 'genuine mismatch requiring intervention'
              when bool_or(classification = 'safe additional safeguard') then 'safe additional safeguard'
              when bool_or(classification = 'semantically equivalent difference') then 'semantically equivalent difference'
              else 'exact match' end::text as classification,
         'no genuine mismatches'::text as expected_configuration,
         format('%s checks; %s exact; %s semantically equivalent; %s safe safeguards; %s failed',
           count(*), count(*) filter (where classification = 'exact match'),
           count(*) filter (where classification = 'semantically equivalent difference'),
           count(*) filter (where classification = 'safe additional safeguard'),
           count(*) filter (where not ok)) as actual_configuration,
         coalesce(bool_and(ok), false) as ok
  from classified_checks
)
select category, object_name, classification, expected_configuration, actual_configuration, ok
from (
  select category, object_name, classification, expected_configuration, actual_configuration, ok from classified_checks
  union all
  select * from overall
) result
order by case when category = 'OVERALL' then 1 else 0 end, category, object_name;

commit;
