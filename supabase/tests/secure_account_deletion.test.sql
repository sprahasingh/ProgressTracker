begin;
select plan(5);

select is((select confdeltype from pg_constraint where conname='goals_category_owner_fk' and conrelid='public.goals'::regclass), 'c'::"char", 'deleting a category cascades only its account-owned goals');
select is((select confdeltype from pg_constraint where conname='daily_entries_category_owner_fk' and conrelid='public.daily_entries'::regclass), 'c'::"char", 'deleting a category cascades its entries');
select is((select confdeltype from pg_constraint where conname='goal_metrics_goal_owner_fk' and conrelid='public.goal_metrics'::regclass), 'c'::"char", 'deleting a goal cascades its measures');
select is((select confdeltype from pg_constraint where conname='goal_progress_metric_owner_fk' and conrelid='public.goal_progress_logs'::regclass), 'c'::"char", 'deleting a measure cascades its progress logs');
select is((select confdeltype from pg_constraint where conname='tracker_entries_tracker_owner_fk' and conrelid='public.tracker_entries'::regclass), 'c'::"char", 'deleting a tracker cascades its entries');
select * from finish();
rollback;
