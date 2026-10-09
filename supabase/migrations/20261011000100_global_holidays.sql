-- Account-wide holidays, stored as one synced row per workspace calendar date.
-- Apply after 20261010000100_tracker_bin_permanent_deletion.sql.
begin;

create table public.account_holidays (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  holiday_date date not null,
  reason text check (reason in ('travel', 'exam', 'personal', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_changed_at timestamptz not null default clock_timestamp(),
  server_revision bigint not null default 1 check (server_revision > 0),
  unique (user_id, id),
  unique (user_id, holiday_date)
);

create index account_holidays_user_changed_idx on public.account_holidays(user_id, server_changed_at);
alter table public.account_holidays enable row level security;
revoke all on public.account_holidays from public, anon, authenticated;
grant select on public.account_holidays to authenticated;
create policy account_holidays_select_own on public.account_holidays
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));
comment on table public.account_holidays is 'One account-wide holiday per workspace calendar date. deleted_at is a sync tombstone; check-in data is retained.';
comment on column public.account_holidays.holiday_date is 'Date-only value interpreted using the account workspace time zone; date expansion is DST independent.';

create or replace function public.bump_account_holiday_revision()
returns trigger language plpgsql set search_path = '' as $$
declare current_revision bigint;
begin
  if tg_op = 'UPDATE' then
    if new.server_revision is distinct from old.server_revision then
      raise exception 'stale holiday row revision' using errcode = '40001';
    end if;
    new.server_revision := old.server_revision + 1;
  else
    select server_revision into current_revision from public.account_holidays where user_id = new.user_id and id = new.id;
    if current_revision is null then new.server_revision := 1; end if;
  end if;
  new.server_changed_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.bump_account_holiday_revision() from public, anon, authenticated;
create trigger account_holidays_revision before insert or update on public.account_holidays
  for each row execute function public.bump_account_holiday_revision();

create table public.private_account_holiday_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, operation_id)
);
alter table public.private_account_holiday_receipts enable row level security;
revoke all on public.private_account_holiday_receipts from public, anon, authenticated;

create or replace function public.apply_account_holiday_sync_operation(
  p_expected_user_id uuid, p_operation_id uuid, p_expected_revision bigint, p_record jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_date date;
  v_receipt public.private_account_holiday_receipts%rowtype;
  v_row public.account_holidays%rowtype;
  v_result jsonb;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match holiday workspace' using errcode = '42501';
  end if;
  if p_operation_id is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'invalid holiday sync operation' using errcode = '22023';
  end if;
  v_id := (p_record->>'id')::uuid;
  v_date := (p_record->>'holiday_date')::date;
  if v_id is null or v_date is null then raise exception 'holiday id and date are required' using errcode = '22023'; end if;
  if p_record->>'reason' is not null and p_record->>'reason' not in ('travel','exam','personal','other') then
    raise exception 'unsupported holiday reason' using errcode = '22023';
  end if;

  -- Per-account/date serialization makes competing edits deterministic; revision checks below return conflicts.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday:' || v_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday-operation:' || p_operation_id::text, 1));
  select * into v_receipt from public.private_account_holiday_receipts where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.payload is distinct from p_record then raise exception 'operation id was reused with a different holiday payload' using errcode = '22023'; end if;
    return v_receipt.result;
  end if;

  select * into v_row from public.account_holidays where user_id = v_user_id and id = v_id for update;
  if found and (p_expected_revision is null or p_expected_revision <> v_row.server_revision) then
    v_result := jsonb_build_object('status','conflict','record',to_jsonb(v_row));
  elsif not found and p_expected_revision is not null then
    v_result := jsonb_build_object('status','conflict','record',null);
  elsif not found and exists (select 1 from public.account_holidays where holiday_date = v_date and user_id = v_user_id) then
    select * into v_row from public.account_holidays where holiday_date = v_date and user_id = v_user_id;
    v_result := jsonb_build_object('status','conflict','record',to_jsonb(v_row));
  elsif not found and exists (select 1 from public.account_holidays where id = v_id) then
    v_result := jsonb_build_object('status','conflict','record',null);
  elsif not found then
    insert into public.account_holidays(id,user_id,holiday_date,reason,created_at,updated_at,deleted_at)
    values(v_id,v_user_id,v_date,p_record->>'reason',coalesce((p_record->>'created_at')::timestamptz,now()),coalesce((p_record->>'updated_at')::timestamptz,now()),(p_record->>'deleted_at')::timestamptz)
    returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  else
    update public.account_holidays set holiday_date=v_date, reason=p_record->>'reason',
      updated_at=coalesce((p_record->>'updated_at')::timestamptz,now()), deleted_at=(p_record->>'deleted_at')::timestamptz,
      server_revision=p_expected_revision where user_id=v_user_id and id=v_id returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  end if;
  insert into public.private_account_holiday_receipts(user_id,operation_id,payload,result) values(v_user_id,p_operation_id,p_record,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb) from public, anon;
grant execute on function public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb) to authenticated;
comment on function public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb) is 'Owner-scoped, idempotent holiday write boundary with revision conflict detection.';

commit;
