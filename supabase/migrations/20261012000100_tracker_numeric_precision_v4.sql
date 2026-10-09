-- Allow precision-aware numeric measures in generic tracker definition JSON.
-- Apply after 20261011000100_global_holidays.sql.
-- Existing v1-v3 definitions and their values are not changed.
begin;

alter table public.trackers
  drop constraint if exists trackers_schema_version_check;

alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4));

comment on column public.trackers.schema_version is
  'Version of the generic tracker definition JSON: v2 adds goal planning, v3 adds timezone-aware persistent per-metric allocations, and v4 adds optional numeric precision and allowed increments.';

commit;
