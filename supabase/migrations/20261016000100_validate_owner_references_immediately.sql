-- Owner-chain FKs are deferred so an Auth-user cascade can remove a complete
-- account in one statement. Reject invalid parent references synchronously at
-- each row write, while retaining the FK as the concurrency-safe commit check.
begin;

create or replace function public.enforce_owner_parent_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_id uuid;
  parent_exists boolean;
begin
  if tg_op = 'UPDATE'
     and new.user_id is not distinct from old.user_id
     and (to_jsonb(new)->>tg_argv[0]) is not distinct from (to_jsonb(old)->>tg_argv[0]) then
    return new;
  end if;

  parent_id := (to_jsonb(new)->>tg_argv[0])::uuid;
  if parent_id is null then
    -- Nullable relationships, such as a goal without a category, are valid.
    return new;
  end if;

  execute format(
    'select exists (select 1 from public.%I where user_id = $1 and id = $2)',
    tg_argv[1]
  ) into parent_exists using new.user_id, parent_id;

  if not parent_exists then
    raise exception 'insert or update violates owner-scoped parent reference'
      using errcode = '23503', constraint = tg_argv[2],
        table = tg_table_name, schema = tg_table_schema;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_owner_parent_reference() from public, anon, authenticated;

create trigger goals_category_owner_guard
  before insert or update on public.goals
  for each row execute function public.enforce_owner_parent_reference('category_id', 'categories', 'goals_category_owner_fk');

create trigger daily_entries_category_owner_guard
  before insert or update on public.daily_entries
  for each row execute function public.enforce_owner_parent_reference('category_id', 'categories', 'daily_entries_category_owner_fk');

create trigger goal_metrics_goal_owner_guard
  before insert or update on public.goal_metrics
  for each row execute function public.enforce_owner_parent_reference('goal_id', 'goals', 'goal_metrics_goal_owner_fk');

create trigger goal_progress_metric_owner_guard
  before insert or update on public.goal_progress_logs
  for each row execute function public.enforce_owner_parent_reference('metric_id', 'goal_metrics', 'goal_progress_metric_owner_fk');

create trigger tracker_entries_tracker_owner_guard
  before insert or update on public.tracker_entries
  for each row execute function public.enforce_owner_parent_reference('tracker_id', 'trackers', 'tracker_entries_tracker_owner_fk');

commit;
