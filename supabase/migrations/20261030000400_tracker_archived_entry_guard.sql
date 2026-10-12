-- Keep stale or older clients from recording live check-ins after a tracker
-- has been archived. Tombstones remain allowed so entries can still be deleted.
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
  if new.deleted_at is not null then
    return new;
  end if;

  select tracker.status, tracker.deleted_at
    into v_status, v_deleted_at
    from public.trackers tracker
   where tracker.user_id = new.user_id
     and tracker.id = new.tracker_id;

  if v_status = 'archived' and v_deleted_at is null then
    raise exception 'Archived trackers cannot receive new or edited check-ins.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_archived_tracker_entry() from public, anon, authenticated;

drop trigger if exists tracker_entries_archived_parent_guard on public.tracker_entries;
create trigger tracker_entries_archived_parent_guard
before insert or update on public.tracker_entries
for each row execute function public.guard_archived_tracker_entry();
