-- Durable, account-wide permanent deletion for generic trackers.
-- The cleanup switch defaults OFF. Verify the cron job and migration before enabling it.
begin;

create table if not exists public.tracker_deletion_ledger (
  user_id uuid not null references auth.users(id) on delete cascade,
  tracker_id uuid not null,
  deletion_operation_id uuid not null,
  permanently_deleted_at timestamptz not null default clock_timestamp(),
  primary key (user_id, tracker_id),
  unique (user_id, deletion_operation_id)
);
alter table public.tracker_deletion_ledger enable row level security;
revoke all on public.tracker_deletion_ledger from public, anon, authenticated;
grant select on public.tracker_deletion_ledger to authenticated;
create policy tracker_deletion_ledger_select_own on public.tracker_deletion_ledger
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));
comment on table public.tracker_deletion_ledger is
  'Permanent account-owned tracker tombstones. Retained indefinitely to reject stale device uploads after tracker content is purged.';

create table if not exists public.tracker_deletion_cleanup_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.tracker_deletion_cleanup_control(id, enabled) values (true, false)
  on conflict (id) do nothing;
alter table public.tracker_deletion_cleanup_control enable row level security;
revoke all on public.tracker_deletion_cleanup_control from public, anon, authenticated;

-- One internal routine is shared by manual permanent deletion and the scheduled cleanup.
create or replace function public.finalize_tracker_deletion(p_user_id uuid, p_tracker_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_existing public.tracker_deletion_ledger%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_tracker_id::text, 0));
  select * into v_existing from public.tracker_deletion_ledger
    where user_id = p_user_id and tracker_id = p_tracker_id;
  if found then
    return jsonb_build_object('status', 'already_deleted', 'tracker_id', p_tracker_id,
      'permanently_deleted_at', v_existing.permanently_deleted_at);
  end if;

  select deleted_at into v_deleted_at from public.trackers
    where user_id = p_user_id and id = p_tracker_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'tracker_id', p_tracker_id);
  end if;
  if v_deleted_at is null then
    raise exception 'tracker must be in the Bin before permanent deletion' using errcode = '22023';
  end if;

  insert into public.tracker_deletion_ledger(user_id, tracker_id, deletion_operation_id)
    values (p_user_id, p_tracker_id, p_operation_id)
    on conflict (user_id, tracker_id) do nothing;

  -- Receipts can contain full definitions and entry values; erase those copies too.
  delete from public.sync_operation_receipts r where r.user_id = p_user_id and (
    (r.entity = 'tracker' and r.record_payload->>'id' = p_tracker_id::text)
    or (r.entity = 'tracker_entry' and r.record_payload->>'tracker_id' = p_tracker_id::text)
  );
  delete from public.tracker_entries where user_id = p_user_id and tracker_id = p_tracker_id;
  delete from public.trackers where user_id = p_user_id and id = p_tracker_id;

  return jsonb_build_object('status', 'deleted', 'tracker_id', p_tracker_id,
    'permanently_deleted_at', clock_timestamp());
end;
$$;
revoke all on function public.finalize_tracker_deletion(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.permanently_delete_tracker(
  p_expected_user_id uuid, p_operation_id uuid, p_tracker_id uuid, p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_tracker public.trackers%rowtype;
  v_permanently_deleted_at timestamptz;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match deletion workspace' using errcode = '42501';
  end if;
  if p_operation_id is null or p_tracker_id is null or p_expected_revision is null then
    raise exception 'deletion operation, tracker, and expected revision are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_tracker_id::text, 0));
  select permanently_deleted_at into v_permanently_deleted_at from public.tracker_deletion_ledger
    where user_id = v_user_id and tracker_id = p_tracker_id;
  if found then
    return jsonb_build_object('status', 'already_deleted', 'tracker_id', p_tracker_id,
      'permanently_deleted_at', v_permanently_deleted_at);
  end if;
  select * into v_tracker from public.trackers where user_id = v_user_id and id = p_tracker_id for update;
  if not found then return jsonb_build_object('status', 'not_found', 'tracker_id', p_tracker_id); end if;
  if v_tracker.server_revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
  end if;
  if v_tracker.deleted_at is null then
    raise exception 'tracker must be in the Bin before permanent deletion' using errcode = '22023';
  end if;
  return public.finalize_tracker_deletion(v_user_id, p_tracker_id, p_operation_id);
end;
$$;
revoke all on function public.permanently_delete_tracker(uuid, uuid, uuid, bigint) from public, anon;
grant execute on function public.permanently_delete_tracker(uuid, uuid, uuid, bigint) to authenticated;

-- Replace the upsert RPC so account/tracker locks serialize it with deletion and
-- the ledger check happens before idempotency receipt replay.
create or replace function public.apply_tracker_sync_operation(
  p_expected_user_id uuid, p_operation_id uuid, p_entity text,
  p_expected_revision bigint, p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_tracker_id uuid;
  v_receipt public.sync_operation_receipts%rowtype;
  v_tracker public.trackers%rowtype;
  v_entry public.tracker_entries%rowtype;
  v_result jsonb;
  v_server_deleted_at timestamptz;
  v_permanently_deleted_at timestamptz;
  v_definition jsonb;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match sync workspace' using errcode = '42501';
  end if;
  if p_operation_id is null or p_record is null or jsonb_typeof(p_record) <> 'object'
     or p_entity is null or p_entity not in ('tracker', 'tracker_entry') then
    raise exception 'invalid sync operation' using errcode = '22023';
  end if;
  v_id := (p_record->>'id')::uuid;
  if v_id is null then raise exception 'record id is required' using errcode = '22023'; end if;
  v_tracker_id := case when p_entity = 'tracker' then v_id else (p_record->>'tracker_id')::uuid end;
  if v_tracker_id is null then raise exception 'tracker id is required' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_tracker_id::text, 0));
  select permanently_deleted_at into v_permanently_deleted_at from public.tracker_deletion_ledger
    where user_id = v_user_id and tracker_id = v_tracker_id;
  if found then
    return jsonb_build_object('status', 'permanently_deleted', 'tracker_id', v_tracker_id,
      'permanently_deleted_at', v_permanently_deleted_at);
  end if;
  if p_entity = 'tracker_entry' and exists (
    select 1 from public.trackers where user_id = v_user_id and id = v_tracker_id and deleted_at is not null
  ) then
    return jsonb_build_object('status', 'parent_in_bin', 'tracker_id', v_tracker_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id::text, 1));
  select * into v_receipt from public.sync_operation_receipts
    where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.entity is distinct from p_entity or v_receipt.expected_revision is distinct from p_expected_revision
       or v_receipt.record_payload is distinct from p_record then
      raise exception 'operation id was reused with a different payload' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;

  if p_entity = 'tracker' then
    select * into v_tracker from public.trackers where user_id = v_user_id and id = v_id for update;
    if found and (p_expected_revision is null or p_expected_revision <> v_tracker.server_revision) then
      v_result := jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_tracker));
    elsif not found and p_expected_revision is not null then
      v_result := jsonb_build_object('status', 'conflict', 'record', null);
    elsif not found and exists (select 1 from public.trackers where id = v_id) then
      v_result := jsonb_build_object('status', 'conflict', 'record', null);
    elsif not found then
      v_server_deleted_at := case when (p_record->>'deleted_at') is null then null else clock_timestamp() end;
      v_definition := jsonb_set(p_record->'definition', '{deletedAt}', coalesce(to_jsonb(v_server_deleted_at), 'null'::jsonb), true);
      insert into public.trackers (id, user_id, schema_version, kind, status, name, definition, created_at, updated_at, deleted_at)
      values (v_id, v_user_id, coalesce((p_record->>'schema_version')::smallint, 1), p_record->>'kind', p_record->>'status', p_record->>'name', v_definition,
        coalesce((p_record->>'created_at')::timestamptz, now()), coalesce((p_record->>'updated_at')::timestamptz, now()), v_server_deleted_at)
      returning * into v_tracker;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_tracker));
    else
      if v_tracker.deleted_at <= clock_timestamp() - interval '30 days' and (p_record->>'deleted_at') is null then
        v_result := public.finalize_tracker_deletion(v_user_id, v_id, p_operation_id);
        return jsonb_build_object('status', 'permanently_deleted', 'tracker_id', v_id,
          'permanently_deleted_at', v_result->>'permanently_deleted_at');
      end if;
      v_server_deleted_at := case
        when v_tracker.deleted_at is not null and (p_record->>'deleted_at') is null then null
        when v_tracker.deleted_at is not null then v_tracker.deleted_at
        when (p_record->>'deleted_at') is not null then clock_timestamp()
        else null end;
      v_definition := jsonb_set(p_record->'definition', '{deletedAt}', coalesce(to_jsonb(v_server_deleted_at), 'null'::jsonb), true);
      update public.trackers set schema_version = coalesce((p_record->>'schema_version')::smallint, 1), kind = p_record->>'kind',
        status = p_record->>'status', name = p_record->>'name', definition = v_definition,
        updated_at = coalesce((p_record->>'updated_at')::timestamptz, now()), deleted_at = v_server_deleted_at,
        server_revision = p_expected_revision where user_id = v_user_id and id = v_id returning * into v_tracker;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_tracker));
    end if;
  else
    select * into v_entry from public.tracker_entries where user_id = v_user_id and id = v_id for update;
    if found and (p_expected_revision is null or p_expected_revision <> v_entry.server_revision) then
      v_result := jsonb_build_object('status', 'conflict', 'record', to_jsonb(v_entry));
    elsif not found and p_expected_revision is not null then
      v_result := jsonb_build_object('status', 'conflict', 'record', null);
    elsif not found and exists (select 1 from public.tracker_entries where id = v_id) then
      v_result := jsonb_build_object('status', 'conflict', 'record', null);
    elsif not found then
      insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values, note, created_at, updated_at, deleted_at)
      values (v_id, v_user_id, v_tracker_id, (p_record->>'entry_date')::date, p_record->>'outcome', coalesce(p_record->'entry_values', '{}'::jsonb), coalesce(p_record->>'note', ''),
        coalesce((p_record->>'created_at')::timestamptz, now()), coalesce((p_record->>'updated_at')::timestamptz, now()), (p_record->>'deleted_at')::timestamptz)
      returning * into v_entry;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_entry));
    else
      update public.tracker_entries set tracker_id = v_tracker_id, entry_date = (p_record->>'entry_date')::date, outcome = p_record->>'outcome',
        entry_values = coalesce(p_record->'entry_values', '{}'::jsonb), note = coalesce(p_record->>'note', ''),
        updated_at = coalesce((p_record->>'updated_at')::timestamptz, now()), deleted_at = (p_record->>'deleted_at')::timestamptz,
        server_revision = p_expected_revision where user_id = v_user_id and id = v_id returning * into v_entry;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_entry));
    end if;
  end if;
  insert into public.sync_operation_receipts(user_id, operation_id, entity, expected_revision, record_payload, result)
    values (v_user_id, p_operation_id, p_entity, p_expected_revision, p_record, v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) from public, anon;
grant execute on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) to authenticated;

-- Force all writes through the serialized RPC so REST clients cannot bypass the ledger.
revoke insert, update, delete on public.trackers, public.tracker_entries from anon, authenticated;
grant select on public.trackers, public.tracker_entries to authenticated;

create or replace function public.purge_expired_tracker_bin()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker record;
  v_deleted_at timestamptz;
  v_count integer := 0;
begin
  if not coalesce((select enabled from public.tracker_deletion_cleanup_control where id), false) then return 0; end if;
  for v_tracker in select user_id, id from public.trackers
    where deleted_at <= clock_timestamp() - interval '30 days' order by deleted_at, id limit 500
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_tracker.user_id::text || ':' || v_tracker.id::text, 0));
    select deleted_at into v_deleted_at from public.trackers
      where user_id = v_tracker.user_id and id = v_tracker.id for update;
    if found and v_deleted_at <= clock_timestamp() - interval '30 days' then
      perform public.finalize_tracker_deletion(v_tracker.user_id, v_tracker.id, gen_random_uuid());
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.purge_expired_tracker_bin() from public, anon, authenticated;

-- Supabase hosted projects support pg_cron. Job is installed active, but the
-- control row deliberately keeps it inert until a human verifies the migration/job.
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'progress-tracker-bin-cleanup') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'progress-tracker-bin-cleanup';
  end if;
  perform cron.schedule('progress-tracker-bin-cleanup', '17 * * * *', 'select public.purge_expired_tracker_bin();');
end;
$$;

comment on function public.purge_expired_tracker_bin() is 'Scheduled hourly. Inert until tracker_deletion_cleanup_control.enabled is explicitly set true after operational verification.';
commit;
