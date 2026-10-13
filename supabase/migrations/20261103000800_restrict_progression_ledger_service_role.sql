-- The progression ledger is read-only to authenticated owners. Backend jobs
-- must use reviewed server-side routines, not direct ledger writes.
begin;
revoke all on public.progression_events, public.progression_event_sources from service_role;
commit;
