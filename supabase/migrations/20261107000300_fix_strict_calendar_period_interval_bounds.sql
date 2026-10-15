-- Repair stored functions when the preceding strict-calendar migration has
-- already been applied with PostgreSQL-invalid combined interval literals.
-- The original migration is also corrected for fresh installations.
begin;

do $$
declare
  v_function record;
  v_definition text;
  v_repaired integer := 0;
begin
  for v_function in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.prosrc like '%interval ''1 month-1 day''%'
        or p.prosrc like '%interval ''1 year-1 day''%')
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_function.oid);
    v_definition := replace(v_definition,
      'interval ''1 month-1 day''',
      'interval ''1 month'' - interval ''1 day''');
    v_definition := replace(v_definition,
      'interval ''1 year-1 day''',
      'interval ''1 year'' - interval ''1 day''');
    execute v_definition;
    v_repaired := v_repaired + 1;
  end loop;

  raise notice 'Repaired % stored strict calendar function(s).', v_repaired;
end;
$$;

commit;
