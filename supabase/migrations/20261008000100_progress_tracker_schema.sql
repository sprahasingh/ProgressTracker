-- ProgressTracker cloud schema, migration 1.
-- Safe to apply to a new project. This migration only creates app-owned tables.
begin;

create table if not exists public.categories (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  icon text not null default '',
  description text,
  accent text not null default '',
  schedule jsonb not null default '{"kind":"every-day"}'::jsonb
    check (jsonb_typeof(schedule) = 'object' and schedule ? 'kind'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, id)
);

create table if not exists public.goals (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '',
  category_id uuid,
  start_date date not null,
  target_date date not null,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'archived')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint goals_date_order check (target_date >= start_date),
  constraint goals_category_owner_fk foreign key (user_id, category_id)
    references public.categories (user_id, id) on delete restrict
);

create table if not exists public.daily_entries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id uuid not null,
  entry_date date not null,
  status text not null check (status in ('completed', 'skipped')),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  unique (user_id, category_id, entry_date),
  constraint daily_entries_category_owner_fk foreign key (user_id, category_id)
    references public.categories (user_id, id) on delete restrict
);

create table if not exists public.daily_journals (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  journal_date date not null,
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  unique (user_id, journal_date)
);

create table if not exists public.goal_metrics (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  goal_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  unit text not null default '',
  target numeric not null check (target > 0 and target < 'Infinity'::numeric),
  weight numeric check (weight is null or (weight >= 0 and weight < 'Infinity'::numeric)),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint goal_metrics_goal_owner_fk foreign key (user_id, goal_id)
    references public.goals (user_id, id) on delete restrict
);

create table if not exists public.goal_progress_logs (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  metric_id uuid not null,
  progress_date date not null,
  value numeric not null check (value >= 0 and value < 'Infinity'::numeric),
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  note text,
  unique (user_id, id),
  constraint goal_progress_metric_owner_fk foreign key (user_id, metric_id)
    references public.goal_metrics (user_id, id) on delete restrict
);

create table if not exists public.app_settings (
  id text not null default 'general' check (id = 'general'),
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  appearance text not null default 'system' check (appearance in ('light', 'dark', 'system')),
  backup_reminder_days integer check (backup_reminder_days is null or backup_reminder_days > 0),
  updated_at timestamptz not null default now()
);

-- RLS is mandatory on every exposed application table.
alter table public.categories enable row level security;
alter table public.goals enable row level security;
alter table public.daily_entries enable row level security;
alter table public.daily_journals enable row level security;
alter table public.goal_metrics enable row level security;
alter table public.goal_progress_logs enable row level security;
alter table public.app_settings enable row level security;

revoke all on public.categories, public.goals, public.daily_entries, public.daily_journals,
  public.goal_metrics, public.goal_progress_logs, public.app_settings from anon, authenticated;
grant select, insert, update, delete on public.categories, public.goals, public.daily_entries,
  public.daily_journals, public.goal_metrics, public.goal_progress_logs, public.app_settings to authenticated;

-- Drop named policies first so the migration can be safely re-applied during development.
drop policy if exists categories_select_own on public.categories;
drop policy if exists categories_insert_own on public.categories;
drop policy if exists categories_update_own on public.categories;
drop policy if exists categories_delete_own on public.categories;
drop policy if exists goals_select_own on public.goals;
drop policy if exists goals_insert_own on public.goals;
drop policy if exists goals_update_own on public.goals;
drop policy if exists goals_delete_own on public.goals;
drop policy if exists daily_entries_select_own on public.daily_entries;
drop policy if exists daily_entries_insert_own on public.daily_entries;
drop policy if exists daily_entries_update_own on public.daily_entries;
drop policy if exists daily_entries_delete_own on public.daily_entries;
drop policy if exists daily_journals_select_own on public.daily_journals;
drop policy if exists daily_journals_insert_own on public.daily_journals;
drop policy if exists daily_journals_update_own on public.daily_journals;
drop policy if exists daily_journals_delete_own on public.daily_journals;
drop policy if exists goal_metrics_select_own on public.goal_metrics;
drop policy if exists goal_metrics_insert_own on public.goal_metrics;
drop policy if exists goal_metrics_update_own on public.goal_metrics;
drop policy if exists goal_metrics_delete_own on public.goal_metrics;
drop policy if exists goal_progress_logs_select_own on public.goal_progress_logs;
drop policy if exists goal_progress_logs_insert_own on public.goal_progress_logs;
drop policy if exists goal_progress_logs_update_own on public.goal_progress_logs;
drop policy if exists goal_progress_logs_delete_own on public.goal_progress_logs;
drop policy if exists app_settings_select_own on public.app_settings;
drop policy if exists app_settings_insert_own on public.app_settings;
drop policy if exists app_settings_update_own on public.app_settings;
drop policy if exists app_settings_delete_own on public.app_settings;

-- Each operation is explicit; update checks both current and resulting ownership.
create policy categories_select_own on public.categories for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy categories_insert_own on public.categories for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy categories_update_own on public.categories for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy categories_delete_own on public.categories for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy goals_select_own on public.goals for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goals_insert_own on public.goals for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goals_update_own on public.goals for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goals_delete_own on public.goals for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy daily_entries_select_own on public.daily_entries for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_entries_insert_own on public.daily_entries for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_entries_update_own on public.daily_entries for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_entries_delete_own on public.daily_entries for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy daily_journals_select_own on public.daily_journals for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_journals_insert_own on public.daily_journals for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_journals_update_own on public.daily_journals for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy daily_journals_delete_own on public.daily_journals for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy goal_metrics_select_own on public.goal_metrics for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_metrics_insert_own on public.goal_metrics for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_metrics_update_own on public.goal_metrics for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_metrics_delete_own on public.goal_metrics for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy goal_progress_logs_select_own on public.goal_progress_logs for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_progress_logs_insert_own on public.goal_progress_logs for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_progress_logs_update_own on public.goal_progress_logs for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy goal_progress_logs_delete_own on public.goal_progress_logs for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy app_settings_select_own on public.app_settings for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy app_settings_insert_own on public.app_settings for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()) and id = 'general');
create policy app_settings_update_own on public.app_settings for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()) and id = 'general');
create policy app_settings_delete_own on public.app_settings for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

-- Support per-user scans and reverse FK checks/deletes without table scans.
create index if not exists categories_user_updated_idx on public.categories (user_id, updated_at);
create index if not exists goals_user_updated_idx on public.goals (user_id, updated_at);
create index if not exists goals_user_category_idx on public.goals (user_id, category_id);
create index if not exists daily_entries_user_date_idx on public.daily_entries (user_id, entry_date);
create index if not exists daily_entries_category_fk_idx on public.daily_entries (user_id, category_id);
create index if not exists daily_journals_user_updated_idx on public.daily_journals (user_id, updated_at);
create index if not exists goal_metrics_user_goal_idx on public.goal_metrics (user_id, goal_id);
create index if not exists goal_metrics_user_updated_idx on public.goal_metrics (user_id, updated_at);
create index if not exists goal_progress_user_metric_date_idx on public.goal_progress_logs (user_id, metric_id, progress_date);
create index if not exists goal_progress_user_updated_idx on public.goal_progress_logs (user_id, updated_at);

comment on table public.categories is 'User-owned ProgressTracker categories; deleted_at is a sync tombstone.';
comment on table public.daily_entries is 'User-owned category/date activity; retain deleted rows until sync acknowledges tombstones.';
comment on table public.daily_journals is 'One user-owned journal per calendar date.';
comment on table public.goal_progress_logs is 'User-owned progress snapshots; clients upsert by UUID for retry-safe synchronization.';
comment on column public.categories.updated_at is 'Client-supplied last mutation timestamp used for future sync conflict resolution; not a trusted audit clock.';

commit;
