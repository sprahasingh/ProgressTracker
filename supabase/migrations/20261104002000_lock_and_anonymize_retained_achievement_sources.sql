-- Tighten the Wins snapshot cutoff without rewriting migration 019. The
-- account lock serializes snapshot capture with achievement reconciliation.
begin;

create or replace function public.lock_tracker_wins_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.wins_retention = 'keep_wins' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.user_id::text || ':progression-achievements', 11)
    );
  end if;
  return new;
end;
$$;
revoke all on function public.lock_tracker_wins_snapshot() from public, anon, authenticated, service_role;
create trigger tracker_deletion_lock_wins_snapshot
before insert on public.tracker_deletion_ledger
for each row execute function public.lock_tracker_wins_snapshot();

create or replace function public.clear_retained_achievement_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.wins_retention = 'keep_wins' then
    update public.progression_achievement_progress progress
    set source_event_id = null
    where progress.user_id = new.user_id
      and progress.source_event_id in (
        select source.event_id from public.progression_event_sources source
        where source.user_id = new.user_id and source.tracker_id = new.tracker_id
      );
  end if;
  return new;
end;
$$;
revoke all on function public.clear_retained_achievement_sources() from public, anon, authenticated, service_role;
create trigger tracker_deletion_clear_achievement_sources
after insert on public.tracker_deletion_ledger
for each row execute function public.clear_retained_achievement_sources();

comment on function public.lock_tracker_wins_snapshot() is
  'Serializes Keep Wins snapshots with account achievement reconciliation.';
comment on function public.clear_retained_achievement_sources() is
  'Clears achievement progress pointers to tracker-specific score events before those sources are deleted.';

commit;
