-- Version 6 adds the explicit calendar/effective/ongoing scheduling contract
-- inside the existing tracker definition JSON. No tracker columns are added.
-- Apply after 20261107000100_tracker_manual_goal_allocations_v5.sql.
begin;

alter table public.trackers
  drop constraint if exists trackers_schema_version_check;

alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5, 6));

comment on column public.trackers.schema_version is
  'Version of the generic tracker definition JSON: v2 adds goal planning, v3 adds timezone-aware allocations, v4 adds numeric precision and increments, v5 separates manual allocations, and v6 adds explicit calendar/effective/ongoing scheduling.';

commit;
