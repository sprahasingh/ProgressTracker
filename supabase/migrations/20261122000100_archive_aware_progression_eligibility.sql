begin;

-- Match the frontend boundary: the archive date remains active, and later
-- dates are outside the tracker's progression period. Replacing this single
-- eligibility predicate lets existing entry, streak, Perfect Day, milestone,
-- and achievement reconciliation use the established append-only ledger.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.progression_date_is_eligible(uuid,public.trackers,date)'::regprocedure
  );
  v_updated text;
  v_anchor text := 'if coalesce((v_definition->>''strictMode'')::boolean,false) then return true; end if;';
  v_archive_guard text := 'if p_tracker.status = ''archived'' and p_tracker.definition->>''archivedAt'' is not null and p_date > pg_catalog.left(p_tracker.definition->>''archivedAt'',10)::date then return false; end if; ';
begin
  if pg_catalog.strpos(v_definition, v_anchor) = 0 then
    raise exception 'progression eligibility definition changed; archive boundary migration needs review';
  end if;
  v_updated := pg_catalog.replace(v_definition, v_anchor, v_archive_guard || v_anchor);
  execute v_updated;
end;
$$;

commit;
