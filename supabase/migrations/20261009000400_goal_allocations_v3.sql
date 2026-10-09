-- Allow persistent per-metric, per-date goal allocations in tracker v3 JSON.
-- Existing v1/v2 rows remain valid. Ownership, RLS, revision triggers, and RPC
-- behavior are unchanged; no existing records are rewritten.
begin;

alter table public.trackers
  drop constraint if exists trackers_schema_version_check;

alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3));

comment on column public.trackers.schema_version is
  'Version of generic tracker definition JSON: v2 adds goal planning; v3 adds timezone-aware persistent per-metric daily allocations.';

commit;
