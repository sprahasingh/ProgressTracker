-- Version 5 separates user-fixed cumulative goal allocations from generated
-- daily suggestions. Both remain inside the existing tracker definition JSON.
-- Apply after 20261012000100_tracker_numeric_precision_v4.sql.
begin;

alter table public.trackers
  drop constraint if exists trackers_schema_version_check;

alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5));

comment on column public.trackers.schema_version is
  'Version of the generic tracker definition JSON: v2 adds goal planning, v3 adds timezone-aware allocations, v4 adds numeric precision and increments, and v5 separates manually fixed cumulative allocations from generated plans.';

commit;
