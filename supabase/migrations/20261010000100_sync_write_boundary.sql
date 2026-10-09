-- Authenticated, idempotent write boundary for future offline sync.
-- This migration does not enable client uploads or change existing table RLS.
begin;

create table public.sync_operation_receipts (
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  entity text not null check (entity in ('tracker', 'tracker_entry')),
  expected_revision bigint,
  record_payload jsonb not null check (jsonb_typeof(record_payload) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table public.sync_operation_receipts enable row level security;
revoke all on public.sync_operation_receipts from public, anon, authenticated;

create or replace function public.apply_tracker_sync_operation(
  p_expected_user_id uuid,
  p_operation_id uuid,
  p_entity text,
  p_expected_revision bigint,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_receipt public.sync_operation_receipts%rowtype;
  v_tracker public.trackers%rowtype;
  v_entry public.tracker_entries%rowtype;
  v_result jsonb;
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

  -- Serialize retries with the same receipt key before checking or applying it.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id::text, 0));
  select * into v_receipt from public.sync_operation_receipts
    where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.entity is distinct from p_entity
       or v_receipt.expected_revision is distinct from p_expected_revision
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
      -- Do not disclose another owner's row; its globally unique UUID is simply unavailable.
      v_result := jsonb_build_object('status', 'conflict', 'record', null);
    elsif not found then
      insert into public.trackers (id, user_id, schema_version, kind, status, name, definition, created_at, updated_at, deleted_at)
      values (
        v_id, v_user_id, coalesce((p_record->>'schema_version')::smallint, 1),
        p_record->>'kind', p_record->>'status', p_record->>'name', p_record->'definition',
        coalesce((p_record->>'created_at')::timestamptz, now()),
        coalesce((p_record->>'updated_at')::timestamptz, now()),
        (p_record->>'deleted_at')::timestamptz
      ) returning * into v_tracker;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_tracker));
    else
      update public.trackers set
        schema_version = coalesce((p_record->>'schema_version')::smallint, 1),
        kind = p_record->>'kind', status = p_record->>'status', name = p_record->>'name',
        definition = p_record->'definition', updated_at = coalesce((p_record->>'updated_at')::timestamptz, now()),
        deleted_at = (p_record->>'deleted_at')::timestamptz,
        server_revision = p_expected_revision
      where user_id = v_user_id and id = v_id returning * into v_tracker;
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
      values (
        v_id, v_user_id, (p_record->>'tracker_id')::uuid, (p_record->>'entry_date')::date,
        p_record->>'outcome', coalesce(p_record->'entry_values', '{}'::jsonb), coalesce(p_record->>'note', ''),
        coalesce((p_record->>'created_at')::timestamptz, now()),
        coalesce((p_record->>'updated_at')::timestamptz, now()),
        (p_record->>'deleted_at')::timestamptz
      ) returning * into v_entry;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_entry));
    else
      update public.tracker_entries set
        tracker_id = (p_record->>'tracker_id')::uuid, entry_date = (p_record->>'entry_date')::date,
        outcome = p_record->>'outcome', entry_values = coalesce(p_record->'entry_values', '{}'::jsonb),
        note = coalesce(p_record->>'note', ''), updated_at = coalesce((p_record->>'updated_at')::timestamptz, now()),
        deleted_at = (p_record->>'deleted_at')::timestamptz,
        server_revision = p_expected_revision
      where user_id = v_user_id and id = v_id returning * into v_entry;
      v_result := jsonb_build_object('status', 'applied', 'record', to_jsonb(v_entry));
    end if;
  end if;

  insert into public.sync_operation_receipts (user_id, operation_id, entity, expected_revision, record_payload, result)
  values (v_user_id, p_operation_id, p_entity, p_expected_revision, p_record, v_result);
  return v_result;
end;
$$;

revoke all on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) from public, anon;
grant execute on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) to authenticated;

comment on table public.sync_operation_receipts is 'Private idempotency receipts for account-bound sync writes. Clients cannot access this table directly.';
comment on function public.apply_tracker_sync_operation(uuid, uuid, text, bigint, jsonb) is 'Applies generic tracker writes only for auth.uid(), returns revision conflicts without overwriting, and replays matching operation receipts.';

commit;
