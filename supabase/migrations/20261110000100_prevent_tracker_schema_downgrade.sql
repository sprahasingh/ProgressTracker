-- Prevent older, already-open clients from replacing newer tracker definitions.
-- This guards every write path and does not rewrite existing tracker rows.
begin;

create or replace function public.prevent_tracker_schema_downgrade()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.schema_version < old.schema_version then
    raise exception 'tracker schema version cannot be downgraded from % to %', old.schema_version, new.schema_version
      using errcode = '23514';
  end if;
  if new.schema_version = 7
     and new.definition->'scheduling'->>'mode' = 'effective'
     and coalesce(new.definition->'scheduling'->>'effectiveDayCounting', '') not in ('planned-activity-days', 'all-non-holiday-days') then
    raise exception 'schema v7 Effective Days requires an explicit supported counting method'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_tracker_schema_downgrade() from public, anon, authenticated;

create trigger trackers_prevent_schema_downgrade
  before insert or update on public.trackers
  for each row execute function public.prevent_tracker_schema_downgrade();

commit;
