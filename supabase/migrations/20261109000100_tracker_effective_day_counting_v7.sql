-- Schema v7 persists the Effective Days counting method without allowing v6 clients to erase it.
alter table public.trackers drop constraint if exists trackers_schema_version_check;
alter table public.trackers
  add constraint trackers_schema_version_check
  check (schema_version in (1, 2, 3, 4, 5, 6, 7));

comment on constraint trackers_schema_version_check on public.trackers is
  'Tracker definition versions through v7; v7 stores explicit Effective Days counting semantics.';
