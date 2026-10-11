-- Guard measure identity and historical interpretation at the database boundary.
-- This protects writes from older clients that do not enforce the local rules.
create or replace function public.guard_tracker_metric_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_metric jsonb;
  v_new_metric jsonb;
  v_metric_id text;
  v_has_history boolean;
begin
  if exists (
    select 1 from jsonb_array_elements(coalesce(old.definition->'metrics', '[]'::jsonb)) as metric(value)
    where coalesce(value->>'retiredAt', '') = ''
  ) and not exists (
    select 1 from jsonb_array_elements(coalesce(new.definition->'metrics', '[]'::jsonb)) as metric(value)
    where coalesce(value->>'retiredAt', '') = ''
  ) then
    raise exception 'Keep at least one active measure so this tracker can record future check-ins.'
      using errcode = '23514';
  end if;

  for v_old_metric in
    select value from jsonb_array_elements(coalesce(old.definition->'metrics', '[]'::jsonb))
  loop
    v_metric_id := v_old_metric->>'id';
    select value into v_new_metric
      from jsonb_array_elements(coalesce(new.definition->'metrics', '[]'::jsonb))
      where value->>'id' = v_metric_id
      limit 1;

    if v_new_metric is null then
      if exists (
        select 1 from public.tracker_entries entry
        where entry.user_id = old.user_id and entry.tracker_id = old.id
          and coalesce(entry.entry_values, '{}'::jsonb) ? v_metric_id
      ) then
        raise exception 'Measure % has saved check-ins and cannot be removed. Retire it to preserve its history.', v_metric_id
          using errcode = '23514';
      end if;
      continue;
    end if;

    if v_old_metric->>'valueType' is distinct from v_new_metric->>'valueType' then
      raise exception 'Saved measure types cannot be changed. Add a new measure to record values differently.'
        using errcode = '23514';
    end if;

    if coalesce(v_old_metric->>'retiredAt', '') <> '' and coalesce(v_new_metric->>'retiredAt', '') = '' then
      raise exception 'Retired measures cannot be reactivated because their historical context must remain stable.'
        using errcode = '23514';
    end if;

    select exists (
      select 1 from public.tracker_entries entry
      where entry.user_id = old.user_id and entry.tracker_id = old.id
        and coalesce(entry.entry_values, '{}'::jsonb) ? v_metric_id
    ) into v_has_history;

    if v_has_history and (v_old_metric - 'retiredAt' - 'precision') is distinct from (v_new_metric - 'retiredAt' - 'precision') then
      raise exception 'A measure with saved check-ins must keep its original name, unit, and meaning. Retire it and add a new measure instead.'
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.guard_tracker_metric_integrity() from public, anon, authenticated;

drop trigger if exists tracker_metric_integrity_guard on public.trackers;
create trigger tracker_metric_integrity_guard
before update of definition on public.trackers
for each row execute function public.guard_tracker_metric_integrity();
