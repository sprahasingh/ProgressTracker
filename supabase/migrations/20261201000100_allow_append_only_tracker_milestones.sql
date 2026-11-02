begin;

create or replace function public.tracker_milestones_are_append_only(p_old jsonb, p_new jsonb)
returns boolean language sql immutable set search_path = '' as $$
  with old_items as (
    select value, ordinality from jsonb_array_elements(case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end) with ordinality
  ), new_items as (
    select value, ordinality from jsonb_array_elements(case when jsonb_typeof(p_new) = 'array' then p_new else '[]'::jsonb end) with ordinality
  )
  select jsonb_typeof(coalesce(p_old, '[]'::jsonb)) = 'array'
    and jsonb_typeof(coalesce(p_new, '[]'::jsonb)) = 'array'
    and (select count(*) from new_items) >= (select count(*) from old_items)
    and not exists (select 1 from old_items o left join new_items n using (ordinality) where o.value is distinct from n.value)
    and not exists (
      select 1 from new_items n
      where n.ordinality > (select count(*) from old_items)
        and (nullif(n.value->>'id', '') is null
          or exists (select 1 from old_items o where o.value->>'id' = n.value->>'id')
          or (select count(*) from new_items duplicate where duplicate.value->>'id' = n.value->>'id'
              and duplicate.ordinality > (select count(*) from old_items)) > 1)
    )
$$;
revoke all on function public.tracker_milestones_are_append_only(jsonb, jsonb) from public, anon, authenticated, service_role;

do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef('public.apply_tracker_sync_operation(uuid,uuid,text,bigint,jsonb)'::regprocedure);
  v_anchor text := '    if v_tracker.schema_version = 10 then';
  v_old_check text := $old$    if coalesce(p_record->'definition'->'milestones', '[]'::jsonb)
       is distinct from coalesce(v_tracker.definition->'milestones', '[]'::jsonb) then
      return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    end if;

$old$;
begin
  if pg_catalog.strpos(v_definition, v_anchor) = 0 then raise exception 'Expected serialized tracker validation boundary was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_anchor,
    '    if p_entity = ''tracker'' and not public.tracker_milestones_are_append_only(v_tracker.definition->''milestones'', p_record->''definition''->''milestones'') then' || E'\n' ||
    '      return jsonb_build_object(''status'', ''conflict'', ''record'', to_jsonb(v_tracker));' || E'\n' ||
    '    end if;' || E'\n' || v_anchor);
  if pg_catalog.strpos(v_definition, v_old_check) = 0 then raise exception 'Expected v10 milestone immutability check was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old_check, '');
end;
$$;

comment on function public.tracker_milestones_are_append_only(jsonb, jsonb) is
  'Allows tracker sync to append uniquely identified milestones while preserving every existing milestone definition and position.';
commit;
