begin;

-- Null preserves the previous amount-based behavior for historical rows and
-- older clients. New explicit choices apply only to Standard Mode dates.
alter table public.tracker_entries
  add column holiday_treatment text,
  add constraint tracker_entries_holiday_treatment_check
    check (holiday_treatment is null or holiday_treatment in ('keep-holiday', 'count-normal'));

create or replace function public.validate_tracker_entry_holiday_treatment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_definition jsonb;
begin
  if new.holiday_treatment is null then return new; end if;
  if tg_op = 'UPDATE' and old.holiday_treatment is not distinct from new.holiday_treatment then return new; end if;
  select public.progression_tracker_definition_for_date(t.definition, new.entry_date)
    into v_definition
    from public.trackers t
    where t.user_id = new.user_id and t.id = new.tracker_id;
  if not found then return new; end if;
  if coalesce((v_definition->>'strictMode')::boolean, false) then
    raise exception 'Strict Mode check-ins cannot set a holiday treatment' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_tracker_entry_holiday_treatment() from public, anon, authenticated, service_role;
create trigger tracker_entries_holiday_treatment_guard
  before insert or update of holiday_treatment on public.tracker_entries
  for each row execute function public.validate_tracker_entry_holiday_treatment();

-- Extend the established eligibility predicate in place so archive boundaries,
-- timezone handling, effective definitions, and schedules keep their current
-- behavior. Explicit keep-holiday is neutral even with positive measurements;
-- explicit count-normal makes the date an ordinary scheduled opportunity.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.progression_date_is_eligible(uuid,public.trackers,date)'::regprocedure
  );
  v_old text := 'if v_is_holiday and not v_has_positive then return false; end if;';
  v_new text := 'if v_is_holiday and (v_entry.holiday_treatment = ''keep-holiday'' or (v_entry.holiday_treatment is distinct from ''count-normal'' and not v_has_positive)) then return false; end if;';
begin
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'holiday eligibility implementation changed; review holiday treatment integration';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$$;

-- Older clients omit the new JSON field. In that case preserve an existing
-- explicit preference, while new clients may set either supported choice.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.apply_tracker_sync_operation_unchecked(uuid,uuid,text,bigint,jsonb)'::regprocedure
  );
  v_insert_columns text := 'entry_values, note, created_at, updated_at, deleted_at)';
  v_insert_columns_new text := 'entry_values, note, holiday_treatment, created_at, updated_at, deleted_at)';
  v_insert_values text := 'coalesce(p_record->''entry_values'', ''{}''::jsonb), coalesce(p_record->>''note'', ''''),';
  v_insert_values_new text := 'coalesce(p_record->''entry_values'', ''{}''::jsonb), coalesce(p_record->>''note'', ''''), p_record->>''holiday_treatment'',';
  v_update text := 'entry_values = coalesce(p_record->''entry_values'', ''{}''::jsonb), note = coalesce(p_record->>''note'', ''''),';
  v_update_new text := 'entry_values = coalesce(p_record->''entry_values'', ''{}''::jsonb), note = coalesce(p_record->>''note'', ''''), holiday_treatment = case when p_record ? ''holiday_treatment'' then p_record->>''holiday_treatment'' else v_entry.holiday_treatment end,';
begin
  if pg_catalog.strpos(v_definition, v_insert_columns) = 0
     or pg_catalog.strpos(v_definition, v_insert_values) = 0
     or pg_catalog.strpos(v_definition, v_update) = 0 then
    raise exception 'tracker sync RPC implementation changed; review holiday treatment integration';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_insert_columns, v_insert_columns_new);
  v_definition := pg_catalog.replace(v_definition, v_insert_values, v_insert_values_new);
  v_definition := pg_catalog.replace(v_definition, v_update, v_update_new);
  execute v_definition;
end;
$$;

-- Existing trigger logic performs append-only daily XP reconciliation,
-- streak milestones, and Perfect Day/achievement updates. Include treatment
-- changes in that same reconciliation path.
drop trigger if exists tracker_entries_progression_award on public.tracker_entries;
create trigger tracker_entries_progression_award
  after insert or update of tracker_id, entry_date, outcome, entry_values, holiday_treatment, deleted_at
  on public.tracker_entries
  for each row execute function public.reconcile_progression_entry_trigger();

comment on column public.tracker_entries.holiday_treatment is
  'Optional explicit treatment for Standard Mode holiday activity. NULL preserves legacy amount-based override behavior; values are keep-holiday or count-normal.';

commit;
