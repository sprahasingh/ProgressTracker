-- Keep My Wins retains the original, non-operational context for rewards
-- whose source tracker is being permanently deleted. Delete Wins never stores
-- tracker names or source descriptions here.
begin;

create table public.progression_retained_reward_context (
  user_id uuid not null references auth.users(id) on delete cascade,
  context_kind text not null check (context_kind in ('score', 'achievement')),
  event_id uuid not null,
  tracker_display_name text not null,
  deleted_tracker boolean not null default true check (deleted_tracker),
  reward_reason_code text not null,
  source_effective_date date not null,
  recorded_at timestamptz not null,
  xp_delta integer,
  primary key (user_id, context_kind, event_id),
  check (length(btrim(tracker_display_name)) > 0)
);

alter table public.progression_retained_reward_context enable row level security;
revoke all on public.progression_retained_reward_context from public, anon, authenticated, service_role;
grant select on public.progression_retained_reward_context to authenticated;
create policy progression_retained_reward_context_select_own
  on public.progression_retained_reward_context for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.capture_tracker_reward_context_before_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.wins_retention <> 'keep_wins' then return new; end if;

  -- event_sources.display_name is the historical name recorded when the
  -- award was created. Older rows with only the generic deletion label stay
  -- explicitly unavailable instead of substituting a possibly renamed name.
  insert into public.progression_retained_reward_context (
    user_id, context_kind, event_id, tracker_display_name,
    reward_reason_code, source_effective_date, recorded_at, xp_delta
  )
  select event.user_id, 'score', event.id,
    case when nullif(pg_catalog.btrim(source.display_name), '') is null or source.display_name = 'Deleted tracker'
      then 'Tracker name unavailable' else source.display_name end,
    event.reason_code, event.effective_date, event.recorded_at, event.xp_delta
  from public.progression_event_sources source
  join public.progression_events event
    on event.user_id = source.user_id and event.id = source.event_id
  where source.user_id = new.user_id and source.tracker_id = new.tracker_id
  on conflict (user_id, context_kind, event_id) do nothing;

  -- Achievement history keeps its own unlock/revocation timestamp and uses
  -- only the linked server-owned score event for tracker name and reward type.
  insert into public.progression_retained_reward_context (
    user_id, context_kind, event_id, tracker_display_name,
    reward_reason_code, source_effective_date, recorded_at, xp_delta
  )
  select achievement.user_id, 'achievement', achievement.id,
    case when nullif(pg_catalog.btrim(source.display_name), '') is null or source.display_name = 'Deleted tracker'
      then 'Tracker name unavailable' else source.display_name end,
    reward.reason_code, coalesce(achievement.source_date, reward.effective_date),
    achievement.recorded_at, reward.xp_delta
  from public.progression_achievement_events achievement
  join public.progression_events reward
    on reward.user_id = achievement.user_id and reward.id = achievement.source_event_id
  join public.progression_event_sources source
    on source.user_id = reward.user_id and source.event_id = reward.id
  where achievement.user_id = new.user_id and source.tracker_id = new.tracker_id
  on conflict (user_id, context_kind, event_id) do nothing;

  return new;
end;
$$;
revoke all on function public.capture_tracker_reward_context_before_deletion() from public, anon, authenticated, service_role;

-- The existing BEFORE trigger takes the account achievement lock first. This
-- snapshot then runs before the AFTER triggers anonymize achievement sources.
create trigger tracker_deletion_snapshot_reward_context
before insert on public.tracker_deletion_ledger
for each row execute function public.capture_tracker_reward_context_before_deletion();

comment on table public.progression_retained_reward_context is
  'Minimal owner-readable display context for confirmed rewards retained by Keep My Wins. It has no tracker, entry, reward, or achievement foreign keys and stores no activity content.';
comment on function public.capture_tracker_reward_context_before_deletion() is
  'Captures recorded tracker name and server-defined reward context transactionally for Keep My Wins only; Delete Wins stores no identifying snapshots.';

commit;
