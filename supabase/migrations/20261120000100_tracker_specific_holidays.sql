-- Tracker-specific Standard Mode holidays and holiday work overrides.
begin;

create table public.tracker_holidays (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tracker_id uuid not null,
  holiday_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_changed_at timestamptz not null default clock_timestamp(),
  server_revision bigint not null default 1 check (server_revision > 0),
  unique (user_id, id),
  unique (user_id, tracker_id, holiday_date),
  constraint tracker_holidays_tracker_owner_fk foreign key (user_id, tracker_id)
    references public.trackers(user_id, id) on delete cascade
);
create index tracker_holidays_user_changed_idx on public.tracker_holidays(user_id, server_changed_at);
alter table public.tracker_holidays enable row level security;
revoke all on public.tracker_holidays from public, anon, authenticated;
grant select on public.tracker_holidays to authenticated;
create policy tracker_holidays_select_own on public.tracker_holidays
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));
comment on table public.tracker_holidays is 'One independently synced holiday exemption per tracker and workspace-local date. Positive recorded work overrides the exemption without deleting it.';

create or replace function public.bump_tracker_holiday_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.server_revision is distinct from old.server_revision then raise exception 'stale tracker holiday row revision' using errcode = '40001'; end if;
    new.server_revision := old.server_revision + 1;
  else new.server_revision := 1;
  end if;
  new.server_changed_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.bump_tracker_holiday_revision() from public, anon, authenticated;
create trigger tracker_holidays_revision before insert or update on public.tracker_holidays
  for each row execute function public.bump_tracker_holiday_revision();

create table public.private_tracker_holiday_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, operation_id)
);
alter table public.private_tracker_holiday_receipts enable row level security;
revoke all on public.private_tracker_holiday_receipts from public, anon, authenticated;

create or replace function public.purge_tracker_holiday_receipts_on_tracker_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.private_tracker_holiday_receipts r where r.user_id=old.user_id and r.payload->>'tracker_id'=old.id::text;
  return old;
end;
$$;
revoke all on function public.purge_tracker_holiday_receipts_on_tracker_delete() from public,anon,authenticated,service_role;
create trigger tracker_holidays_purge_receipts before delete on public.trackers
for each row execute function public.purge_tracker_holiday_receipts_on_tracker_delete();

create or replace function public.apply_tracker_holiday_sync_operation(
  p_expected_user_id uuid, p_operation_id uuid, p_expected_revision bigint, p_record jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid(); v_id uuid; v_tracker_id uuid; v_date date;
  v_definition jsonb; v_receipt public.private_tracker_holiday_receipts%rowtype;
  v_row public.tracker_holidays%rowtype; v_row_exists boolean := false; v_result jsonb;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then raise exception 'authenticated owner does not match tracker holiday workspace' using errcode = '42501'; end if;
  if p_operation_id is null or jsonb_typeof(p_record) <> 'object' then raise exception 'invalid tracker holiday sync operation' using errcode = '22023'; end if;
  v_id := (p_record->>'id')::uuid; v_tracker_id := (p_record->>'tracker_id')::uuid; v_date := (p_record->>'holiday_date')::date;
  if v_id is null or v_tracker_id is null or v_date is null then raise exception 'tracker holiday ID, tracker, and date are required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':tracker-holiday:' || v_tracker_id::text || ':' || v_date::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':tracker-holiday-operation:' || p_operation_id::text, 1));
  select * into v_receipt from public.private_tracker_holiday_receipts where user_id=v_user_id and operation_id=p_operation_id;
  if found then
    if v_receipt.payload is distinct from p_record then raise exception 'operation ID was reused with a different tracker holiday payload' using errcode = '22023'; end if;
    return v_receipt.result;
  end if;
  select * into v_row from public.tracker_holidays where user_id=v_user_id and id=v_id for update;
  v_row_exists := found;
  if v_row_exists and v_row.tracker_id is distinct from v_tracker_id then raise exception 'tracker holiday cannot be reassigned to another tracker' using errcode = '22023'; end if;
  if (not v_row_exists or (p_record->>'deleted_at') is null) then
    select public.progression_tracker_definition_for_date(t.definition, v_date) into v_definition
      from public.trackers t where t.user_id = v_user_id and t.id = v_tracker_id and t.deleted_at is null;
    if not found then raise exception 'active tracker holidays must reference an available tracker' using errcode = '23503'; end if;
    if coalesce((v_definition->>'strictMode')::boolean, false) then raise exception 'Strict Mode trackers cannot have active tracker-specific holidays' using errcode = '22023'; end if;
  end if;
  if v_row_exists and (p_expected_revision is null or p_expected_revision <> v_row.server_revision) then
    v_result := jsonb_build_object('status','conflict','record',to_jsonb(v_row));
  elsif not v_row_exists and p_expected_revision is not null then
    v_result := jsonb_build_object('status','conflict','record',null);
  elsif not v_row_exists and exists(select 1 from public.tracker_holidays where user_id=v_user_id and tracker_id=v_tracker_id and holiday_date=v_date) then
    select * into v_row from public.tracker_holidays where user_id=v_user_id and tracker_id=v_tracker_id and holiday_date=v_date;
    v_result := jsonb_build_object('status','conflict','record',to_jsonb(v_row));
  elsif not v_row_exists and exists(select 1 from public.tracker_holidays where id=v_id) then
    v_result := jsonb_build_object('status','conflict','record',null);
  elsif not v_row_exists then
    insert into public.tracker_holidays(id,user_id,tracker_id,holiday_date,created_at,updated_at,deleted_at)
      values(v_id,v_user_id,v_tracker_id,v_date,coalesce((p_record->>'created_at')::timestamptz,now()),coalesce((p_record->>'updated_at')::timestamptz,now()),(p_record->>'deleted_at')::timestamptz) returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  else
    update public.tracker_holidays set tracker_id=v_tracker_id, holiday_date=v_date,
      updated_at=coalesce((p_record->>'updated_at')::timestamptz,now()), deleted_at=(p_record->>'deleted_at')::timestamptz,
      server_revision=p_expected_revision where user_id=v_user_id and id=v_id returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  end if;
  insert into public.private_tracker_holiday_receipts(user_id,operation_id,payload,result) values(v_user_id,p_operation_id,p_record,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_tracker_holiday_sync_operation(uuid,uuid,bigint,jsonb) from public, anon;
grant execute on function public.apply_tracker_holiday_sync_operation(uuid,uuid,bigint,jsonb) to authenticated;

-- Work may override a Standard Mode holiday. Only active, date-effective tracker metrics count as positive work.
create or replace function public.progression_entry_has_positive_progress(p_tracker public.trackers, p_entry public.tracker_entries)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_definition jsonb; v_metric jsonb; v_value jsonb; v_id text;
begin
  if p_entry.outcome <> 'recorded' or p_entry.deleted_at is not null then return false; end if;
  v_definition := public.progression_tracker_definition_for_date(p_tracker.definition, p_entry.entry_date);
  for v_metric in select value from jsonb_array_elements(coalesce(v_definition->'metrics','[]'::jsonb)) loop
    if v_metric ? 'retiredAt' and v_metric->'retiredAt' <> 'null'::jsonb then continue; end if;
    v_id := v_metric->>'id';
    if v_id is null then continue; end if;
    v_value := p_entry.entry_values->v_id;
    if v_value is null then continue; end if;
    if v_metric->>'valueType' = 'boolean' and v_value = 'true'::jsonb then return true; end if;
    if v_metric->>'valueType' in ('quantity','duration') and jsonb_typeof(v_value)='number' and (v_value #>> '{}')::numeric > 0 then return true; end if;
    if v_metric->>'valueType' = 'checklist' then
      if jsonb_typeof(v_value)='array' and exists(select 1 from jsonb_array_elements(v_value) item where item='true'::jsonb) then return true; end if;
      if jsonb_typeof(v_value)='object' and exists(select 1 from jsonb_each(v_value) item where item.value='true'::jsonb) then return true; end if;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function public.progression_entry_has_positive_progress(public.trackers,public.tracker_entries) from public,anon,authenticated,service_role;

create or replace function public.progression_date_is_eligible(p_user_id uuid, p_tracker public.trackers, p_date date)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_definition jsonb; v_schedule jsonb; v_zone text; v_created_local_date date; v_anchor date;
  v_weekday integer; v_day integer; v_month_days integer; v_count integer; v_interval integer;
  v_entry public.tracker_entries%rowtype; v_has_positive boolean := false; v_is_holiday boolean := false;
begin
  select s.timezone into v_zone from public.app_settings s where s.user_id=p_user_id and s.timezone_configured;
  if not found or v_zone is null then return false; end if;
  begin v_created_local_date := (p_tracker.created_at at time zone v_zone)::date;
  exception when invalid_parameter_value then return false; end;
  v_definition := public.progression_tracker_definition_for_date(p_tracker.definition,p_date);
  v_schedule := v_definition->'schedule';
  v_anchor := coalesce((v_definition->>'startDate')::date,v_created_local_date);
  if v_anchor is null or p_date<v_anchor or (v_definition->>'deadline' is not null and p_date>(v_definition->>'deadline')::date) then return false; end if;
  if coalesce((v_definition->>'strictMode')::boolean,false) then return true; end if;
  select * into v_entry from public.tracker_entries e where e.user_id=p_user_id and e.tracker_id=p_tracker.id and e.entry_date=p_date and e.deleted_at is null;
  if found then v_has_positive := public.progression_entry_has_positive_progress(p_tracker,v_entry); end if;
  select exists(select 1 from public.account_holidays h where h.user_id=p_user_id and h.holiday_date=p_date and h.deleted_at is null)
    or exists(select 1 from public.tracker_holidays h where h.user_id=p_user_id and h.tracker_id=p_tracker.id and h.holiday_date=p_date and h.deleted_at is null)
    into v_is_holiday;
  if v_is_holiday and not v_has_positive then return false; end if;
  v_weekday := extract(dow from p_date)::integer; v_day := extract(day from p_date)::integer;
  v_month_days := extract(day from (date_trunc('month',p_date::timestamp)+interval '1 month'-interval '1 day'))::integer;
  case v_schedule->>'kind'
    when 'every-day' then return true;
    when 'weekdays' then return v_weekday between 1 and 5;
    when 'selected-weekdays' then return coalesce(v_schedule->'weekdays','[]'::jsonb) @> to_jsonb(v_weekday);
    when 'every-n-days' then v_interval:=greatest(coalesce((v_schedule->>'interval')::integer,0),0); return v_interval>0 and mod(p_date-v_anchor,v_interval)=0;
    when 'times-per-week' then if v_schedule ? 'preferredWeekdays' then return coalesce(v_schedule->'preferredWeekdays','[]'::jsonb) @> to_jsonb(v_weekday); end if; v_count:=coalesce((v_schedule->>'count')::integer,0); return v_count>0 and floor((v_weekday+1)*v_count/7.0)>floor(v_weekday*v_count/7.0);
    when 'times-per-month' then v_count:=coalesce((v_schedule->>'count')::integer,0); return v_count>0 and floor(v_day*v_count::numeric/v_month_days)>floor((v_day-1)*v_count::numeric/v_month_days);
    when 'specific-dates' then return coalesce(v_schedule->'dates','[]'::jsonb) @> to_jsonb(p_date::text);
    when 'once' then return (v_schedule->>'date')::date=p_date;
    else return false;
  end case;
end;
$$;
revoke all on function public.progression_date_is_eligible(uuid,public.trackers,date) from public,anon,authenticated;

create or replace function public.reconcile_tracker_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_tracker uuid; v_date date; v_today date; v_timezone text;
begin
  v_user := coalesce(new.user_id,old.user_id); v_tracker := coalesce(new.tracker_id,old.tracker_id); v_date := coalesce(new.holiday_date,old.holiday_date);
  select coalesce(s.timezone,'UTC') into v_timezone from public.app_settings s where s.user_id=v_user;
  v_today := (clock_timestamp() at time zone coalesce(v_timezone,'UTC'))::date;
  perform public.reconcile_progression_tracker_milestones(v_user,v_tracker);
  if v_date <= v_today then perform public.reconcile_progression_perfect_day(v_user,v_date); end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_tracker_holiday_change() from public,anon,authenticated,service_role;
create trigger tracker_holidays_reconcile_progression after insert or update on public.tracker_holidays
for each row execute function public.reconcile_tracker_holiday_change();

create or replace function public.reconcile_account_holiday_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_date date; v_today date; v_timezone text; v_tracker record;
begin
  v_user := coalesce(new.user_id,old.user_id); v_date := coalesce(new.holiday_date,old.holiday_date);
  select coalesce(s.timezone,'UTC') into v_timezone from public.app_settings s where s.user_id=v_user;
  v_today := (clock_timestamp() at time zone coalesce(v_timezone,'UTC'))::date;
  for v_tracker in select t.id from public.trackers t where t.user_id=v_user and t.deleted_at is null loop
    perform public.reconcile_progression_tracker_milestones(v_user,v_tracker.id);
  end loop;
  if v_date <= v_today then perform public.reconcile_progression_perfect_day(v_user,v_date); end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function public.reconcile_account_holiday_change() from public,anon,authenticated,service_role;
create trigger account_holidays_reconcile_progression after insert or update on public.account_holidays
for each row execute function public.reconcile_account_holiday_change();

commit;
