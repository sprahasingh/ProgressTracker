-- Fail closed on irreversible tracker deletion until attributable XP and
-- dependent achievement reconciliation can be performed atomically. The
-- account-wide reconstructed opening balance cannot be allocated per tracker.
begin;

-- Prevent scheduled destructive cleanup while progression reconciliation is
-- unavailable. Keep any existing cron job installed but inert.
update public.tracker_deletion_cleanup_control
set enabled = false, updated_at = clock_timestamp()
where id = true and enabled;

create or replace function public.guard_tracker_deletion_with_progression_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Keep account deletion intact. The account's progression data is removed by
  -- its existing cascading foreign keys, rather than tracker-level reversal.
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  if exists (
    select 1 from public.progression_events e where e.user_id = old.user_id
  ) or exists (
    select 1 from public.progression_achievement_events e where e.user_id = old.user_id
  ) then
    raise exception 'permanent tracker deletion is unavailable while progression history exists; exact XP and achievement reconciliation is not yet supported'
      using errcode = '55000';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_tracker_deletion_with_progression_history() from public, anon, authenticated, service_role;

drop trigger if exists trackers_guard_progression_deletion on public.trackers;
create trigger trackers_guard_progression_deletion
before delete on public.trackers
for each row execute function public.guard_tracker_deletion_with_progression_history();

-- Moving a tracker to/from the Bin changes current eligibility, but its
-- historical rewards and achievement unlocks stay intact during recovery.
-- Lifecycle-only tombstone updates therefore do not run historical scorers.
drop trigger if exists trackers_progression_definition_changed on public.trackers;
create trigger trackers_progression_definition_changed_insert
after insert on public.trackers
for each row execute function public.reconcile_progression_tracker_trigger();
create trigger trackers_progression_definition_changed_update
after update on public.trackers
for each row
when (
  (old.status, old.kind, old.name, old.definition - 'deletedAt' - 'updatedAt')
  is distinct from
  (new.status, new.kind, new.name, new.definition - 'deletedAt' - 'updatedAt')
)
execute function public.reconcile_progression_tracker_trigger();

drop trigger if exists z_progression_achievement_tracker_change on public.trackers;
create trigger z_progression_achievement_tracker_insert_delete
after insert or delete on public.trackers
for each row execute function public.reconcile_progression_achievements_trigger();
create trigger z_progression_achievement_tracker_update
after update on public.trackers
for each row
when (
  (old.status, old.kind, old.name, old.definition - 'deletedAt' - 'updatedAt')
  is distinct from
  (new.status, new.kind, new.name, new.definition - 'deletedAt' - 'updatedAt')
)
execute function public.reconcile_progression_achievements_trigger();

-- Defense in depth: synced active-entry writes are forbidden while the parent
-- is either archived or in the Bin. Tombstones remain permitted for cleanup.
create or replace function public.guard_archived_tracker_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_deleted_at timestamptz;
begin
  if new.deleted_at is not null then return new; end if;
  select tracker.status, tracker.deleted_at into v_status, v_deleted_at
    from public.trackers tracker
   where tracker.user_id = new.user_id and tracker.id = new.tracker_id;
  if v_deleted_at is not null then
    raise exception 'Trackers in the Bin cannot receive new or edited check-ins.' using errcode = '23514';
  end if;
  if v_status = 'archived' then
    raise exception 'Archived trackers cannot receive new or edited check-ins.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_archived_tracker_entry() from public, anon, authenticated, service_role;

comment on function public.guard_tracker_deletion_with_progression_history() is
  'Blocks irreversible tracker deletion when progression events exist because exact per-tracker XP and achievement reconciliation is not implemented. Cascading account deletion remains permitted.';
comment on function public.guard_archived_tracker_entry() is
  'Rejects live check-in writes for archived or Bin trackers; deletion tombstones are allowed.';

commit;
