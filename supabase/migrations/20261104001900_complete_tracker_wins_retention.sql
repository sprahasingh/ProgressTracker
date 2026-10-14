-- Preserve the complete confirmed Wins state before tracker and entry
-- reconciliation runs, without retaining tracker-identifying references.
begin;

create table public.progression_retained_achievement_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null,
  progress numeric not null check (progress >= 0),
  target numeric not null check (target > 0),
  current_tier integer not null check (current_tier >= 0),
  repeatable boolean not null,
  source_date date,
  retained_at timestamptz not null default clock_timestamp(),
  primary key (user_id, achievement_id)
);
alter table public.progression_retained_achievement_progress enable row level security;
revoke all on public.progression_retained_achievement_progress from public, anon, authenticated, service_role;
grant select on public.progression_retained_achievement_progress to authenticated;
create policy progression_retained_achievement_progress_select_own
  on public.progression_retained_achievement_progress for select to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.capture_tracker_wins_before_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.wins_retention <> 'keep_wins' then return new; end if;

  -- The ledger insert occurs inside the serialized finalizer, before entry
  -- deletion invokes historical reconciliation. Store only account-level
  -- progress and its date, never a tracker, entry, or event identifier.
  insert into public.progression_retained_achievement_progress
    (user_id, achievement_id, progress, target, current_tier, repeatable, source_date)
  select p.user_id, p.achievement_id, p.progress, p.target, p.current_tier, p.repeatable, p.source_date
  from public.progression_achievement_progress p
  where p.user_id = new.user_id
  on conflict (user_id, achievement_id) do update set
    progress = greatest(public.progression_retained_achievement_progress.progress, excluded.progress),
    target = excluded.target,
    current_tier = greatest(public.progression_retained_achievement_progress.current_tier, excluded.current_tier),
    repeatable = excluded.repeatable,
    source_date = coalesce(excluded.source_date, public.progression_retained_achievement_progress.source_date),
    retained_at = clock_timestamp();

  insert into public.progression_retained_achievement_unlocks(user_id, achievement_event_id)
  select event.user_id, event.id
  from public.progression_achievement_events event
  where event.user_id = new.user_id and event.event_type = 'unlocked'
    and not exists (
      select 1 from public.progression_achievement_events reversal
      where reversal.user_id = event.user_id and reversal.event_type = 'revoked'
        and reversal.reverses_event_id = event.id
    )
  on conflict do nothing;

  -- Preserve the earned date but remove the joinable source and any source
  -- description for accomplishments whose score source belongs to this tracker.
  update public.progression_achievement_events achievement
  set source_event_id = null,
      source_reference = '{"retained_after_tracker_deletion":true}'::jsonb
  where achievement.user_id = new.user_id
    and achievement.source_event_id in (
      select source.event_id from public.progression_event_sources source
      where source.user_id = new.user_id and source.tracker_id = new.tracker_id
    );


  return new;
end;
$$;
revoke all on function public.capture_tracker_wins_before_deletion() from public, anon, authenticated, service_role;
create trigger tracker_deletion_capture_wins
after insert on public.tracker_deletion_ledger
for each row execute function public.capture_tracker_wins_before_deletion();

-- Reconciliation can remove source-derived progress after deletion. Keep the
-- confirmed, anonymized aggregate as a floor, while current eligibility and
-- award generation continue to be computed only from surviving activity.
create or replace function public.preserve_retained_achievement_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_retained public.progression_retained_achievement_progress%rowtype;
begin
  select * into v_retained
  from public.progression_retained_achievement_progress retained
  where retained.user_id = new.user_id and retained.achievement_id = new.achievement_id;
  if found then
    new.progress := greatest(new.progress, v_retained.progress);
    new.target := v_retained.target;
    new.current_tier := greatest(new.current_tier, v_retained.current_tier);
    new.repeatable := v_retained.repeatable;
    new.source_event_id := null;
    new.source_date := coalesce(new.source_date, v_retained.source_date);
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_retained_achievement_progress() from public, anon, authenticated, service_role;
create trigger progression_preserve_retained_achievement_progress
before insert or update on public.progression_achievement_progress
for each row execute function public.preserve_retained_achievement_progress();

comment on table public.progression_retained_achievement_progress is
  'Anonymized confirmed achievement progress retained after Keep Wins tracker deletion; contains no tracker, entry, or event identifiers.';
comment on function public.capture_tracker_wins_before_deletion() is
  'Atomically snapshots confirmed achievement progress and unlocks before Keep Wins removes the tracker and entries.';

commit;
