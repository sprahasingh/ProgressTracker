-- Reconcile goal milestone award keys that disappear or become invalid, and
-- serialize entry writes with the tracker definition used to score them.
begin;

create index progression_award_state_active_goal_milestones_idx
  on public.progression_award_state (user_id, tracker_id)
  where reason_code = 'GOAL_MILESTONE' and current_xp > 0;

do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_goal_tracker(uuid,uuid)'::regprocedure);
  v_old := '  v_today date;';
  v_new := '  v_today date;' || E'\n' || '  v_stale_award public.progression_award_state%rowtype;';
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected goal reconciliation declaration was not found'; end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := '  v_completion_date:=coalesce(((v_tracker.definition->>''completedAt'')::timestamptz at time zone v_timezone)::date,v_today);';
  v_new := $replacement$
  -- Award keys encode tracker and milestone IDs, so look up every active key
  -- created for this tracker after processing current definitions. This also
  -- catches IDs removed from the JSON and milestones whose target was cleared.
  -- Keep the award active when a supported current definition is present and
  -- was reconciled above; invalid or absent definitions are ineligible.
  for v_stale_award in
    select a.*
    from public.progression_award_state a
    where a.user_id = p_user_id and a.tracker_id = p_tracker_id
      and a.reason_code = 'GOAL_MILESTONE' and a.current_xp > 0
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(v_tracker.definition->'milestones', '[]'::jsonb)) as milestones(milestone)
        where nullif(milestone->>'id', '') is not null
          and md5(p_user_id::text || ':goal-tracker-milestone:' || p_tracker_id::text || ':' || (milestone->>'id'))::uuid = a.award_key
          and jsonb_typeof(milestone->'targetValue') = 'number'
          and (
            milestone ? 'type'
            or exists (
              select 1 from jsonb_array_elements(coalesce(v_tracker.definition->'metrics', '[]'::jsonb)) as metrics(metric)
              where metric->>'id' = milestone->>'metricId' and metric->>'retiredAt' is null
            )
            or (
              milestone->>'metricId' is null
              and (select count(*) from jsonb_array_elements(coalesce(v_tracker.definition->'metrics', '[]'::jsonb)) as metrics(metric)
                   where metric->>'retiredAt' is null) = 1
            )
          )
      )
  loop
    perform public.reconcile_progression_award(p_user_id, v_stale_award.award_key, 'GOAL_MILESTONE', v_today, 25,
      p_tracker_id, null, null, false, 'A configured goal milestone is no longer eligible');
  end loop;

  v_completion_date:=coalesce(((v_tracker.definition->>'completedAt')::timestamptz at time zone v_timezone)::date,v_today);$replacement$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then raise exception 'Expected goal reconciliation completion boundary was not found'; end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

create or replace function public.lock_tracker_for_entry_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Tracker updates already lock their row. Taking the same lock for entry
  -- writes makes reconciliation see one complete serialization order.
  if tg_op = 'DELETE' then
    perform tracker.id from public.trackers tracker
      where tracker.user_id = old.user_id and tracker.id = old.tracker_id
      for update;
    return old;
  end if;

  if tg_op = 'UPDATE' and (old.user_id, old.tracker_id) is distinct from (new.user_id, new.tracker_id) then
    perform tracker.id from public.trackers tracker
      where (tracker.user_id = old.user_id and tracker.id = old.tracker_id)
         or (tracker.user_id = new.user_id and tracker.id = new.tracker_id)
      order by tracker.id
      for update;
  else
    perform tracker.id from public.trackers tracker
      where tracker.user_id = new.user_id and tracker.id = new.tracker_id
      for update;
  end if;
  return new;
end;
$$;
revoke all on function public.lock_tracker_for_entry_reconciliation() from public, anon, authenticated, service_role;

drop trigger if exists tracker_entry_definition_reconciliation_lock on public.tracker_entries;
create trigger tracker_entry_definition_reconciliation_lock
  before insert or update or delete on public.tracker_entries
  for each row execute function public.lock_tracker_for_entry_reconciliation();

comment on function public.lock_tracker_for_entry_reconciliation() is
  'Serializes tracker-entry changes with the current tracker definition so award reconciliation cannot commit against stale configuration.';

create or replace function public.guard_tracker_custom_field_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_field jsonb;
  v_new_field jsonb;
  v_field_id text;
  v_has_history boolean;
begin
  for v_old_field in
    select field.value from jsonb_array_elements(coalesce(old.definition->'customFields', '[]'::jsonb)) as field(value)
  loop
    v_field_id := v_old_field->>'id';
    if v_field_id is null then continue; end if;

    select field.value into v_new_field
      from jsonb_array_elements(coalesce(new.definition->'customFields', '[]'::jsonb)) as field(value)
      where field.value->>'id' = v_field_id limit 1;

    select exists (
      select 1 from public.tracker_entries entry
      where entry.user_id = old.user_id and entry.tracker_id = old.id
        and coalesce(entry.entry_values, '{}'::jsonb) ? ('field:' || v_field_id)
    ) into v_has_history;

    if v_new_field is null then
      if v_has_history or v_old_field ? 'retiredAt' then
        raise exception 'Custom field % has saved check-ins and cannot be removed. Retire it to preserve its history.', v_field_id
          using errcode = '23514';
      end if;
      continue;
    end if;

    if v_old_field ? 'retiredAt' then
      if not (v_new_field ? 'retiredAt') then
        raise exception 'Retired custom fields cannot be reactivated because their historical context must remain stable.'
          using errcode = '23514';
      end if;
      if (v_old_field - 'position') is distinct from (v_new_field - 'position') then
        raise exception 'Retired custom fields must keep their original definition so their history keeps its meaning.'
          using errcode = '23514';
      end if;
    end if;

    if v_has_history and (v_old_field - 'retiredAt' - 'position') is distinct from (v_new_field - 'retiredAt' - 'position') then
      raise exception 'A custom field with saved check-ins must keep its original name, type, options, and required setting. Retire it and add a new field instead.'
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.guard_tracker_custom_field_integrity() from public, anon, authenticated, service_role;

drop trigger if exists tracker_custom_field_integrity_guard on public.trackers;
create trigger tracker_custom_field_integrity_guard
  before update of definition on public.trackers
  for each row execute function public.guard_tracker_custom_field_integrity();

comment on function public.guard_tracker_custom_field_integrity() is
  'Prevents sync writers from changing or removing the meaning of custom fields referenced by retained tracker entries.';

commit;
