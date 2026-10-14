-- Publish the server-computed two-part Consistency Star qualification to the
-- existing progress JSON field; clients must not approximate eligible days.
begin;

do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  v_marker text := $marker$      source_date=excluded.source_date,updated_at=clock_timestamp();$marker$;
  v_replacement text := $replacement$      source_date=excluded.source_date,updated_at=clock_timestamp();

     if v_record.achievement_id='consistency-star' then
       update public.progression_achievement_progress
       set qualification_details=pg_catalog.jsonb_build_object(
         'status',case when v_consistency_days >= 30 and coalesce(v_consistency,0) >= 80 then 'qualified' else 'in_progress' end,
         'label','Consistency Star qualification',
         'eligible_days',v_consistency_days,
         'eligible_days_target',30,
         'adherence_percent',case when v_consistency is null then null else round(v_consistency,1) end,
         'adherence_target_percent',80
       ),updated_at=clock_timestamp()
       where user_id=p_user_id and achievement_id='consistency-star';
     end if;$replacement$;
begin
  if pg_catalog.length(v_definition)-pg_catalog.length(pg_catalog.replace(v_definition,v_marker,'')) <> pg_catalog.length(v_marker) then
    raise exception 'Expected exactly one consistency progress upsert marker';
  end if;
  execute pg_catalog.replace(v_definition,v_marker,v_replacement);
end;
$$;

-- A badge read refreshes base qualifications as well as period/repeatable
-- details, so the returned JSON is authoritative even without a new check-in.
create or replace function public.refresh_my_progression_qualification_progress()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform public.reconcile_progression_achievements_base(auth.uid());
  perform public.reconcile_progression_repeatable_achievements(auth.uid());
end;
$$;
revoke all on function public.refresh_my_progression_qualification_progress() from public,anon,authenticated,service_role;
grant execute on function public.refresh_my_progression_qualification_progress() to authenticated;

commit;
