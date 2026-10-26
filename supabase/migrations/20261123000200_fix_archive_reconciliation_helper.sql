-- Correct the archive queue helper's timezone lookup to use its composite argument.
begin;

create or replace function public.queue_progression_archive_change(
  p_old public.trackers, p_new public.trackers
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_archive_date date;
  v_new_archive_date date;
  v_boundary date;
  v_timezone text := 'UTC';
  v_through date;
begin
  if not public.progression_tracker_change_is_archive_only(p_old, p_new) then return; end if;
  if p_old.definition->>'archivedAt' is not null then v_old_archive_date := pg_catalog.left(p_old.definition->>'archivedAt', 10)::date; end if;
  if p_new.definition->>'archivedAt' is not null then v_new_archive_date := pg_catalog.left(p_new.definition->>'archivedAt', 10)::date; end if;
  v_boundary := coalesce(least(v_old_archive_date, v_new_archive_date), v_old_archive_date, v_new_archive_date);
  if v_boundary is null then return; end if;
  select coalesce(s.timezone, 'UTC') into v_timezone from public.app_settings s where s.user_id = p_new.user_id;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then v_timezone := 'UTC'; end if;
  v_through := (clock_timestamp() at time zone v_timezone)::date;
  perform public.queue_progression_archive_reconciliation(p_new.user_id, p_new.id, v_boundary + 1, v_through);
end;
$$;

commit;
