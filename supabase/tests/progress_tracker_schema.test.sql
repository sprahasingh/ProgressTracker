begin;
select plan(18);

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

select * from finish();
rollback;
