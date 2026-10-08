-- Add the generic tracker model alongside the deployed legacy schema.
-- Existing categories/goals/activity are not modified or removed.
begin;

create table public.trackers (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  schema_version smallint not null default 1 check (schema_version = 1),
  kind text not null check (kind in ('habit', 'goal', 'challenge', 'project')),
  status text not null check (status in ('active', 'paused', 'completed', 'archived')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  definition jsonb not null check (
    jsonb_typeof(definition) = 'object'
    and definition->>'schemaVersion' = schema_version::text
    and definition->>'id' = id::text
    and definition->>'kind' = kind
    and definition->>'status' = status
    and jsonb_typeof(definition->'metrics') = 'array'
    and jsonb_typeof(definition->'schedule') = 'object'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_changed_at timestamptz not null default clock_timestamp(),
  server_revision bigint not null default 1 check (server_revision > 0),
  deleted_at timestamptz,
  unique (user_id, id)
);

create table public.tracker_entries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tracker_id uuid not null,
  entry_date date not null,
  outcome text not null check (outcome in ('recorded', 'skipped')),
  entry_values jsonb not null default '{}'::jsonb check (jsonb_typeof(entry_values) = 'object'),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_changed_at timestamptz not null default clock_timestamp(),
  server_revision bigint not null default 1 check (server_revision > 0),
  deleted_at timestamptz,
  unique (user_id, id),
  unique (user_id, tracker_id, entry_date),
  constraint tracker_entries_tracker_owner_fk foreign key (user_id, tracker_id)
    references public.trackers (user_id, id) on delete no action deferrable initially immediate
);

create or replace function public.bump_generic_server_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_revision bigint;
begin
  if tg_op = 'UPDATE' then
    if new.server_revision is distinct from old.server_revision then
      raise exception 'stale ProgressTracker row revision'
        using errcode = '40001';
    end if;
    new.server_revision := old.server_revision + 1;
  else
    execute format(
      'select server_revision from %I.%I where user_id = $1 and id = $2',
      tg_table_schema, tg_table_name
    ) into current_revision using new.user_id, new.id;
    if current_revision is null then
      new.server_revision := 1;
    end if;
  end if;
  new.server_changed_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.bump_generic_server_revision() from public, anon, authenticated;

create trigger trackers_server_revision before insert or update on public.trackers
  for each row execute function public.bump_generic_server_revision();
create trigger tracker_entries_server_revision before insert or update on public.tracker_entries
  for each row execute function public.bump_generic_server_revision();

alter table public.trackers enable row level security;
alter table public.tracker_entries enable row level security;
revoke all on public.trackers, public.tracker_entries from anon, authenticated;
grant select, insert, update, delete on public.trackers, public.tracker_entries to authenticated;

create policy trackers_select_own on public.trackers for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy trackers_insert_own on public.trackers for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy trackers_update_own on public.trackers for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy trackers_delete_own on public.trackers for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create policy tracker_entries_select_own on public.tracker_entries for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy tracker_entries_insert_own on public.tracker_entries for insert to authenticated
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy tracker_entries_update_own on public.tracker_entries for update to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));
create policy tracker_entries_delete_own on public.tracker_entries for delete to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create index trackers_user_changed_idx on public.trackers (user_id, server_changed_at);
create index tracker_entries_user_changed_idx on public.tracker_entries (user_id, server_changed_at);

comment on table public.trackers is 'Versioned user-owned generic tracker definitions; definition stores the validated domain payload.';
comment on table public.tracker_entries is 'User-owned dated values for generic trackers; deleted_at is a synchronization tombstone.';
comment on column public.trackers.updated_at is 'Client event metadata; server_revision and server_changed_at are server-maintained.';
comment on column public.tracker_entries.updated_at is 'Client event metadata; server_revision and server_changed_at are server-maintained.';

commit;
