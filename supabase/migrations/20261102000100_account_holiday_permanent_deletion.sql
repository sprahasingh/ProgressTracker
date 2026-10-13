-- Owner-scoped permanent deletion and inert 30-day cleanup for account holidays.
-- This is additive to tracker deletion. The holiday cleanup control defaults off.
begin;

do $$
begin
  if to_regclass('public.account_holidays') is null then
    raise exception 'account_holidays is missing; apply 20261011000100_global_holidays.sql first';
  end if;
end;
$$;

create table public.account_holiday_deletion_ledger (
  user_id uuid not null references auth.users(id) on delete cascade,
  holiday_id uuid not null,
  deletion_operation_id uuid not null,
  permanently_deleted_at timestamptz not null default clock_timestamp(),
  primary key (user_id, holiday_id),
  unique (user_id, deletion_operation_id)
);
alter table public.account_holiday_deletion_ledger enable row level security;
revoke all on public.account_holiday_deletion_ledger from public, anon, authenticated;
grant select on public.account_holiday_deletion_ledger to authenticated;
create policy account_holiday_deletion_ledger_select_own on public.account_holiday_deletion_ledger
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));
comment on table public.account_holiday_deletion_ledger is
  'Permanent account holiday tombstones. Retained so stale devices cannot restore purged holidays.';

create table public.private_account_holiday_deletion_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  holiday_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, operation_id)
);
alter table public.private_account_holiday_deletion_receipts enable row level security;
revoke all on public.private_account_holiday_deletion_receipts from public, anon, authenticated;

create table public.account_holiday_cleanup_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.account_holiday_cleanup_control(id, enabled) values (true, false);
alter table public.account_holiday_cleanup_control enable row level security;
revoke all on public.account_holiday_cleanup_control from public, anon, authenticated;
comment on table public.account_holiday_cleanup_control is
  'Separate off-by-default gate for scheduled permanent deletion of expired account holidays.';

create or replace function public.finalize_account_holiday_deletion(p_user_id uuid, p_holiday_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.account_holiday_deletion_ledger%rowtype;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':holiday-id:' || p_holiday_id::text, 0));
  select * into v_existing from public.account_holiday_deletion_ledger
    where user_id = p_user_id and holiday_id = p_holiday_id;
  if found then
    return jsonb_build_object('status','already_deleted','holiday_id',p_holiday_id,
      'permanently_deleted_at',v_existing.permanently_deleted_at);
  end if;
  insert into public.account_holiday_deletion_ledger(user_id, holiday_id, deletion_operation_id)
    values (p_user_id, p_holiday_id, p_operation_id)
    on conflict (user_id, holiday_id) do nothing;
  select * into v_existing from public.account_holiday_deletion_ledger
    where user_id = p_user_id and holiday_id = p_holiday_id;
  delete from public.private_account_holiday_receipts
    where user_id = p_user_id and payload->>'id' = p_holiday_id::text;
  delete from public.account_holidays where user_id = p_user_id and id = p_holiday_id;
  v_result := jsonb_build_object('status','deleted','holiday_id',p_holiday_id,
    'permanently_deleted_at',v_existing.permanently_deleted_at);
  return v_result;
end;
$$;
revoke all on function public.finalize_account_holiday_deletion(uuid,uuid,uuid) from public, anon, authenticated;

create or replace function public.permanently_delete_account_holiday(
  p_expected_user_id uuid, p_operation_id uuid, p_holiday_id uuid, p_expected_revision bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_date date;
  v_row public.account_holidays%rowtype;
  v_ledger public.account_holiday_deletion_ledger%rowtype;
  v_receipt public.private_account_holiday_deletion_receipts%rowtype;
  v_result jsonb;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match holiday workspace' using errcode = '42501';
  end if;
  if p_operation_id is null or p_holiday_id is null then
    raise exception 'holiday id and deletion operation id are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday-delete-operation:' || p_operation_id::text, 1));
  select * into v_ledger from public.account_holiday_deletion_ledger
    where user_id = v_user_id and holiday_id = p_holiday_id;
  if found then
    return jsonb_build_object('status','already_deleted','holiday_id',p_holiday_id,
      'permanently_deleted_at',v_ledger.permanently_deleted_at);
  end if;
  select * into v_receipt from public.private_account_holiday_deletion_receipts
    where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.holiday_id is distinct from p_holiday_id then
      raise exception 'operation id was reused for a different holiday' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;
  select holiday_date into v_date from public.account_holidays
    where user_id = v_user_id and id = p_holiday_id;
  if not found then return jsonb_build_object('status','not_found','holiday_id',p_holiday_id); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday:' || v_date::text, 0));
  select * into v_row from public.account_holidays
    where user_id = v_user_id and id = p_holiday_id for update;
  if not found then return jsonb_build_object('status','not_found','holiday_id',p_holiday_id); end if;
  if v_row.holiday_date <> v_date or p_expected_revision is null or p_expected_revision <> v_row.server_revision then
    v_result := jsonb_build_object('status','conflict','holiday_id',p_holiday_id,'record',to_jsonb(v_row));
  elsif v_row.deleted_at is null then
    v_result := jsonb_build_object('status','conflict','holiday_id',p_holiday_id,'record',to_jsonb(v_row));
  else
    v_result := public.finalize_account_holiday_deletion(v_user_id, p_holiday_id, p_operation_id);
  end if;
  -- A conflict is not a completed operation. Do not receipt it, so the same
  -- queued request can retry after the user resolves the revision conflict.
  if v_result->>'status' in ('deleted','already_deleted') then
    insert into public.private_account_holiday_deletion_receipts(user_id,operation_id,holiday_id,result)
      values(v_user_id,p_operation_id,p_holiday_id,v_result);
  end if;
  return v_result;
end;
$$;
revoke all on function public.permanently_delete_account_holiday(uuid,uuid,uuid,bigint) from public, anon;
grant execute on function public.permanently_delete_account_holiday(uuid,uuid,uuid,bigint) to authenticated;
comment on function public.permanently_delete_account_holiday(uuid,uuid,uuid,bigint) is
  'Owner-scoped, revision-checked permanent deletion for a holiday already in Recently removed.';

-- Ledger checks precede idempotency receipt replay so an old sync request cannot
-- re-create a holiday after manual deletion or scheduled cleanup.
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
  v_ledger public.account_holiday_deletion_ledger%rowtype;
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
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday:' || v_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':holiday-operation:' || p_operation_id::text, 1));
  select * into v_ledger from public.account_holiday_deletion_ledger
    where user_id = v_user_id and holiday_id = v_id;
  if found then
    return jsonb_build_object('status','permanently_deleted','holiday_id',v_id,
      'permanently_deleted_at',v_ledger.permanently_deleted_at);
  end if;
  select * into v_receipt from public.private_account_holiday_receipts where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.payload is distinct from p_record then raise exception 'operation id was reused with a different holiday payload' using errcode = '22023'; end if;
    return v_receipt.result;
  end if;
  select * into v_row from public.account_holidays where user_id = v_user_id and id = v_id for update;
  if found and v_row.deleted_at <= clock_timestamp() - interval '30 days' and (p_record->>'deleted_at') is null then
    v_result := public.finalize_account_holiday_deletion(v_user_id,v_id,p_operation_id);
    v_result := jsonb_set(v_result,'{status}','"permanently_deleted"'::jsonb);
    insert into public.private_account_holiday_receipts(user_id,operation_id,payload,result) values(v_user_id,p_operation_id,p_record,v_result);
    return v_result;
  end if;
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
    values(v_id,v_user_id,v_date,p_record->>'reason',coalesce((p_record->>'created_at')::timestamptz,now()),coalesce((p_record->>'updated_at')::timestamptz,now()),case when (p_record->>'deleted_at') is null then null else clock_timestamp() end)
    returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  else
    update public.account_holidays set holiday_date=v_date, reason=p_record->>'reason',
      updated_at=coalesce((p_record->>'updated_at')::timestamptz,now()),
      deleted_at=case
        when (p_record->>'deleted_at') is null then null
        when v_row.deleted_at is null then clock_timestamp()
        else v_row.deleted_at
      end,
      server_revision=p_expected_revision where user_id=v_user_id and id=v_id returning * into v_row;
    v_result := jsonb_build_object('status','applied','record',to_jsonb(v_row));
  end if;
  insert into public.private_account_holiday_receipts(user_id,operation_id,payload,result) values(v_user_id,p_operation_id,p_record,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb) from public, anon;
grant execute on function public.apply_account_holiday_sync_operation(uuid,uuid,bigint,jsonb) to authenticated;

create or replace function public.purge_expired_account_holiday_bin()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_holiday record; v_current public.account_holidays%rowtype; v_count integer := 0;
begin
  if not coalesce((select enabled from public.account_holiday_cleanup_control where id), false) then return 0; end if;
  for v_holiday in
    select user_id,id,holiday_date from public.account_holidays
    where deleted_at <= clock_timestamp() - interval '30 days'
    order by deleted_at,id limit 500
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_holiday.user_id::text || ':holiday:' || v_holiday.holiday_date::text, 0));
    select * into v_current from public.account_holidays
      where user_id=v_holiday.user_id and id=v_holiday.id for update;
    if found and v_current.holiday_date=v_holiday.holiday_date
       and v_current.deleted_at <= clock_timestamp() - interval '30 days' then
      perform public.finalize_account_holiday_deletion(v_holiday.user_id,v_holiday.id,gen_random_uuid());
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.purge_expired_account_holiday_bin() from public, anon, authenticated;
comment on function public.purge_expired_account_holiday_bin() is
  'Permanently deletes account holidays after 30 days in Recently removed when the separate cleanup control is enabled.';

create extension if not exists pg_cron with schema pg_catalog;
do $$
declare v_count integer; v_ok boolean; v_job_id bigint; v_timezone text := current_setting('cron.timezone', true);
begin
  if v_timezone is not null and upper(v_timezone) not in ('UTC','GMT','ETC/UTC') then
    raise exception 'pg_cron timezone must be UTC or GMT before scheduling holiday cleanup (current: %)', v_timezone;
  end if;
  select count(*), coalesce(bool_and(schedule='0 3 * * *' and command='select public.purge_expired_account_holiday_bin();' and active and username=current_user),false)
    into v_count,v_ok from cron.job where jobname='progress-tracker-holiday-cleanup';
  if v_count=1 and v_ok then return; end if;
  for v_job_id in select jobid from cron.job where jobname='progress-tracker-holiday-cleanup' loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule('progress-tracker-holiday-cleanup','0 3 * * *','select public.purge_expired_account_holiday_bin();');
end;
$$;

commit;
