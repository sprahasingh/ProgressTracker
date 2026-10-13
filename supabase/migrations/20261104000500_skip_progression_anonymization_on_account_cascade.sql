-- Account deletion already cascades every progression row. Avoid updating
-- award state after its auth.users parent has been removed by the cascade.
begin;

create or replace function public.anonymize_tracker_progression_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists(select 1 from auth.users where id = old.user_id) then
    return old;
  end if;

  delete from public.progression_event_sources
  where user_id = old.user_id and tracker_id = old.id;

  update public.progression_award_state
  set tracker_id = null, source_id = null, updated_at = clock_timestamp()
  where user_id = old.user_id and tracker_id = old.id;

  return old;
end;
$$;

revoke all on function public.anonymize_tracker_progression_sources() from public, anon, authenticated, service_role;

commit;
