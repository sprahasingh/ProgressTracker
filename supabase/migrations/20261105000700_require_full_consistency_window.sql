-- Consistency Star requires a complete 30 eligible-day observation window.
begin;

do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  v_old text := $old$    v_tier := case when v_record.repeatable then floor(v_record.progress / v_record.target)::integer
      when v_record.progress >= v_record.target then 1 else 0 end;$old$;
  v_new text := $new$    v_tier := case
      when v_record.achievement_id='consistency-star' and v_consistency_days < 30 then 0
      when v_record.repeatable then floor(v_record.progress / v_record.target)::integer
      when v_record.progress >= v_record.target then 1 else 0 end;$new$;
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'Expected progression achievement tier calculation was not found';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

commit;
