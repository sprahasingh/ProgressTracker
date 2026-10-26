begin;

create or replace function public.reconcile_tracker_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_new_user uuid;
  v_user uuid;
  v_tracker uuid;
  v_date date;
  v_today date;
  v_timezone text;
begin
  if tg_op <> 'INSERT' then v_old_user := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.user_id; end if;
  for v_user in select distinct user_id from unnest(array[v_old_user,v_new_user]) user_id where user_id is not null loop
    select coalesce(s.timezone,'UTC') into v_timezone from public.app_settings s where s.user_id=v_user;
    v_today := (clock_timestamp() at time zone coalesce(v_timezone,'UTC'))::date;
    for v_tracker in
      select distinct tracker_id from (
        select old.tracker_id where tg_op <> 'INSERT' and old.user_id=v_user
        union all
        select new.tracker_id where tg_op <> 'DELETE' and new.user_id=v_user
      ) affected where tracker_id is not null
    loop
      perform public.reconcile_progression_tracker_milestones(v_user,v_tracker);
    end loop;
    for v_date in
      select distinct holiday_date from (
        select old.holiday_date where tg_op <> 'INSERT' and old.user_id=v_user
        union all
        select new.holiday_date where tg_op <> 'DELETE' and new.user_id=v_user
      ) affected where holiday_date is not null and holiday_date<=v_today
    loop
      perform public.reconcile_progression_perfect_day(v_user,v_date);
    end loop;
    perform public.reconcile_progression_achievements(v_user);
  end loop;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_tracker_holiday_change() from public,anon,authenticated,service_role;
drop trigger if exists tracker_holidays_reconcile_progression on public.tracker_holidays;
create trigger tracker_holidays_reconcile_progression after insert or update or delete on public.tracker_holidays
for each row execute function public.reconcile_tracker_holiday_change();

create or replace function public.reconcile_account_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_user uuid;
  v_new_user uuid;
  v_user uuid;
  v_date date;
  v_today date;
  v_timezone text;
  v_tracker record;
begin
  if tg_op <> 'INSERT' then v_old_user := old.user_id; end if;
  if tg_op <> 'DELETE' then v_new_user := new.user_id; end if;
  for v_user in select distinct user_id from unnest(array[v_old_user,v_new_user]) user_id where user_id is not null loop
    select coalesce(s.timezone,'UTC') into v_timezone from public.app_settings s where s.user_id=v_user;
    v_today := (clock_timestamp() at time zone coalesce(v_timezone,'UTC'))::date;
    for v_tracker in select t.id from public.trackers t where t.user_id=v_user and t.deleted_at is null loop
      perform public.reconcile_progression_tracker_milestones(v_user,v_tracker.id);
    end loop;
    for v_date in
      select distinct holiday_date from (
        select old.holiday_date where tg_op <> 'INSERT' and old.user_id=v_user
        union all
        select new.holiday_date where tg_op <> 'DELETE' and new.user_id=v_user
      ) affected where holiday_date is not null and holiday_date<=v_today
    loop
      perform public.reconcile_progression_perfect_day(v_user,v_date);
    end loop;
    perform public.reconcile_progression_achievements(v_user);
  end loop;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_account_holiday_change() from public,anon,authenticated,service_role;
drop trigger if exists account_holidays_reconcile_progression on public.account_holidays;
create trigger account_holidays_reconcile_progression after insert or update or delete on public.account_holidays
for each row execute function public.reconcile_account_holiday_change();

commit;
