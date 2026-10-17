-- Match the client-side v10 evaluation normalization: an omitted strictMode
-- has the same meaning as false. This changes comparison behavior only; it
-- does not rewrite tracker definitions or historical evaluation snapshots.
begin;

do $migration$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.progression_tracker_evaluation_signature(jsonb)'::regprocedure
  );
  v_old text := $$'strictMode', p_evaluation->'strictMode'$$;
  v_new text := $$'strictMode', coalesce(p_evaluation->'strictMode', 'false'::jsonb)$$;
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'The v10 evaluation signature no longer has its expected strictMode expression';
  end if;
  if pg_catalog.strpos(pg_catalog.substr(v_definition, pg_catalog.strpos(v_definition, v_old) + pg_catalog.length(v_old)), v_old) > 0 then
    raise exception 'The v10 evaluation signature contains multiple strictMode expressions';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$migration$;

commit;
