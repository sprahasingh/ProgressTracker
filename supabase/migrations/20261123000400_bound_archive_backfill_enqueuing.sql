-- Scan existing archived trackers in durable bounded batches. The migration
-- itself does not enumerate or reconcile a user's full history.
begin;

create table public.private_progression_archive_backfill_control (
  singleton boolean primary key default true check (singleton),
  last_user_id uuid,
  last_tracker_id uuid,
  complete boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  check ((last_user_id is null) = (last_tracker_id is null))
);
alter table public.private_progression_archive_backfill_control enable row level security;
revoke all on public.private_progression_archive_backfill_control from public, anon, authenticated, service_role;
insert into public.private_progression_archive_backfill_control(singleton) values (true);

create or replace function public.enqueue_progression_archive_reconciliation_batch(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_control public.private_progression_archive_backfill_control%rowtype;
  v_tracker public.trackers%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_processed integer := 0;
  v_boundary date;
  v_through date;
  v_timezone text;
  v_more boolean;
begin
  select * into v_control from public.private_progression_archive_backfill_control where singleton for update;
  if not found or v_control.complete then
    return jsonb_build_object('processed', 0, 'remaining', false);
  end if;

  for v_tracker in
    select t.* from public.trackers t
    where t.status = 'archived' and t.deleted_at is null and t.definition ? 'archivedAt'
      and (v_control.last_user_id is null or (t.user_id, t.id) > (v_control.last_user_id, v_control.last_tracker_id))
    order by t.user_id, t.id limit v_limit
  loop
    v_boundary := pg_catalog.left(v_tracker.definition->>'archivedAt', 10)::date;
    select coalesce(s.timezone, 'UTC') into v_timezone
    from public.app_settings s where s.user_id = v_tracker.user_id;
    if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = coalesce(v_timezone, 'UTC')) then
      v_timezone := 'UTC';
    end if;
    v_through := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
    perform public.queue_progression_archive_reconciliation(
      v_tracker.user_id, v_tracker.id, v_boundary + 1, v_through
    );
    update public.private_progression_archive_backfill_control
    set last_user_id = v_tracker.user_id, last_tracker_id = v_tracker.id, updated_at = clock_timestamp()
    where singleton;
    v_processed := v_processed + 1;
  end loop;

  select * into v_control from public.private_progression_archive_backfill_control where singleton;
  select exists (
    select 1 from public.trackers t
    where t.status = 'archived' and t.deleted_at is null and t.definition ? 'archivedAt'
      and (v_control.last_user_id is null or (t.user_id, t.id) > (v_control.last_user_id, v_control.last_tracker_id))
  ) into v_more;
  update public.private_progression_archive_backfill_control
  set complete = not v_more, updated_at = clock_timestamp()
  where singleton;
  return jsonb_build_object('processed', v_processed, 'remaining', v_more);
end;
$$;
revoke all on function public.enqueue_progression_archive_reconciliation_batch(integer) from public, anon, authenticated, service_role;

-- Every scheduled worker invocation inventories at most 200 trackers and then
-- performs the existing capped reconciliation batch. A failed transaction
-- leaves both cursors unchanged for a deterministic retry.
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.process_progression_archive_reconciliation_batch(integer)'::regprocedure
  );
  v_anchor text := E'begin\n  while v_processed < v_limit loop';
  v_replacement text := E'begin\n  perform public.enqueue_progression_archive_reconciliation_batch(least(v_limit, 200));\n  while v_processed < v_limit loop';
begin
  if pg_catalog.strpos(v_definition, v_anchor) = 0 then
    raise exception 'archive reconciliation worker changed; bounded inventory integration needs review';
  end if;
  execute pg_catalog.replace(v_definition, v_anchor, v_replacement);
end;
$$;

commit;
