-- When the workspace timezone is first synced or explicitly changed, evaluate
-- Perfect Day for that workspace's current calendar date immediately.
begin;

create or replace function public.reconcile_perfect_day_after_timezone_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text := new.timezone;
  v_today date;
begin
  if tg_op = 'UPDATE' and old.timezone is not distinct from new.timezone then
    return new;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_today := (clock_timestamp() at time zone v_timezone)::date;
  perform public.reconcile_progression_perfect_day(new.user_id, v_today);
  return new;
end;
$$;

revoke all on function public.reconcile_perfect_day_after_timezone_change() from public, anon, authenticated, service_role;

drop trigger if exists app_settings_reconcile_perfect_day_timezone on public.app_settings;
create trigger app_settings_reconcile_perfect_day_timezone
after insert or update of timezone on public.app_settings
for each row execute function public.reconcile_perfect_day_after_timezone_change();

comment on function public.reconcile_perfect_day_after_timezone_change() is
  'Re-evaluates the current Perfect Day occurrence when account timezone changes, using the same workspace date boundary as Today.';

commit;
