-- User-owned notification preferences and records. This migration does not
-- schedule jobs or enable delivery; those require explicit server secrets and setup.
begin;

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  daily_enabled boolean not null default true,
  daily_times time[] not null default array['16:00'::time, '22:00'::time],
  overdue_enabled boolean not null default true,
  overdue_times time[] not null default array['00:00'::time, '10:00'::time],
  remind_partial boolean not null default false,
  motivation_mode text not null default 'off' check (motivation_mode in ('off','general','custom','both')),
  motivation_times time[] not null default array['18:00'::time],
  motivation_weekdays smallint[] not null default array[1,2,3,4,5,6,0],
  timezone text not null default 'UTC',
  quiet_start time,
  quiet_end time,
  allow_overdue_during_quiet boolean not null default false,
  daily_limit smallint not null default 4 check (daily_limit between 1 and 20),
  motivation_daily_limit smallint not null default 1 check (motivation_daily_limit between 0 and 5),
  tracker_ids uuid[],
  updated_at timestamptz not null default now(),
  constraint notification_preferences_timezone_valid check (char_length(timezone) between 1 and 100)
);

create table public.notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, endpoint)
);

create table public.custom_motivation_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(btrim(message)) between 1 and 240),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, message)
);

create table public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 240),
  category text not null check (category in ('pending','overdue','motivation','achievement','holiday','info')),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 500),
  href text not null default '/' check (href like '/%' and href not like '%://%' and href not like '//%'),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique(user_id, dedupe_key)
);
create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.notification_devices(id) on delete cascade,
  dedupe_key text not null,
  scheduled_for timestamptz not null,
  status text not null check (status in ('queued','sent','failed','superseded')),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, device_id, dedupe_key)
);
create index app_notifications_user_created_idx on public.app_notifications(user_id, created_at desc);
create index notification_devices_enabled_user_idx on public.notification_devices(user_id) where enabled;
create index notification_delivery_due_idx on public.notification_delivery_attempts(next_attempt_at) where status in ('queued','failed');

alter table public.notification_preferences enable row level security;
alter table public.notification_devices enable row level security;
alter table public.custom_motivation_messages enable row level security;
alter table public.app_notifications enable row level security;
alter table public.notification_delivery_attempts enable row level security;

revoke all on public.notification_preferences, public.notification_devices, public.custom_motivation_messages, public.app_notifications, public.notification_delivery_attempts from anon, authenticated;
grant select, insert, update, delete on public.notification_preferences, public.notification_devices, public.custom_motivation_messages to authenticated;
grant select on public.app_notifications to authenticated;
grant update (read_at) on public.app_notifications to authenticated;

create policy notification_preferences_own on public.notification_preferences for all to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy notification_devices_own on public.notification_devices for all to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy custom_motivation_own on public.custom_motivation_messages for all to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy app_notifications_select_own on public.app_notifications for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy app_notifications_update_own on public.app_notifications for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));

comment on table public.notification_devices is 'User-owned Web Push endpoints; delivery keys must be accessed only by trusted server functions.';
comment on table public.app_notifications is 'Idempotent per-user notification center records. Server insert/upsert is service-role only.';
commit;
