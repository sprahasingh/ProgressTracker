-- Correct the month-end interval expression in the repeatable achievement
-- reconciler without rewriting the already-applied migration that introduced it.
do $migration$
declare
  v_definition text;
  v_old_expression text := $old$+interval '1 month-1 day'$old$;
begin
  v_definition := pg_get_functiondef(
    'public.reconcile_progression_repeatable_achievements(uuid)'::regprocedure
  );

  if position(v_old_expression in v_definition) = 0 then
    raise exception 'Expected month-end expression was not found in repeatable achievement reconciler';
  end if;

  v_definition := replace(
    v_definition,
    v_old_expression,
    $new$+interval '1 month'-interval '1 day'$new$
  );
  execute v_definition;
end;
$migration$;

