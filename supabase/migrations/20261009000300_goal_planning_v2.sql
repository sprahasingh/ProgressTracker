-- Allow version 2 generic tracker definitions with persistent goal planning.
-- Existing rows remain schema version 1; ownership, RLS, revision triggers,
-- the sync RPC, and idempotency receipts are unchanged.
begin;

alter table public.trackers
  drop constraint if exists trackers_schema_version_check;

alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2));

comment on column public.trackers.schema_version is
  'Version of the generic tracker definition JSON; version 2 adds goal planning without changing per-check-in thresholds.';

commit;
