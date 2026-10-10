-- Make the existing per-account ownership chains safe for an Auth user deletion.
-- No rows are modified; Auth deletion remains a separate, explicit server action.
begin;

alter table public.goals drop constraint goals_category_owner_fk;
alter table public.goals add constraint goals_category_owner_fk
  foreign key (user_id, category_id) references public.categories(user_id, id)
  on delete cascade deferrable initially immediate;

alter table public.daily_entries drop constraint daily_entries_category_owner_fk;
alter table public.daily_entries add constraint daily_entries_category_owner_fk
  foreign key (user_id, category_id) references public.categories(user_id, id)
  on delete cascade deferrable initially immediate;

alter table public.goal_metrics drop constraint goal_metrics_goal_owner_fk;
alter table public.goal_metrics add constraint goal_metrics_goal_owner_fk
  foreign key (user_id, goal_id) references public.goals(user_id, id)
  on delete cascade deferrable initially immediate;

alter table public.goal_progress_logs drop constraint goal_progress_metric_owner_fk;
alter table public.goal_progress_logs add constraint goal_progress_metric_owner_fk
  foreign key (user_id, metric_id) references public.goal_metrics(user_id, id)
  on delete cascade deferrable initially immediate;

alter table public.tracker_entries drop constraint tracker_entries_tracker_owner_fk;
alter table public.tracker_entries add constraint tracker_entries_tracker_owner_fk
  foreign key (user_id, tracker_id) references public.trackers(user_id, id)
  on delete cascade deferrable initially immediate;

commit;
