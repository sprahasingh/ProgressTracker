-- A retry after successful deletion has no live tracker revision to compare.
-- Check the owner's durable tombstone first; require a revision only when a
-- tracker row still exists and is about to be deleted.
begin;

create or replace function public.permanently_delete_tracker(
  p_expected_user_id uuid,p_operation_id uuid,p_tracker_id uuid,p_expected_revision bigint,p_wins_retention text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_tracker public.trackers%rowtype;
begin
  if v_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'authenticated owner does not match deletion workspace' using errcode='42501';
  end if;
  if p_operation_id is null or p_tracker_id is null then
    raise exception 'deletion operation and tracker are required' using errcode='22023';
  end if;
  if p_wins_retention is null or p_wins_retention not in ('keep_wins','delete_wins') then
    raise exception 'a valid Wins retention choice is required' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text || ':' || p_tracker_id::text, 0));
  select * into v_tracker from public.trackers where user_id=v_user_id and id=p_tracker_id for update;
  if not found then
    if exists(select 1 from public.tracker_deletion_ledger l where l.user_id=v_user_id and l.tracker_id=p_tracker_id) then
      return jsonb_build_object('status','already_deleted','tracker_id',p_tracker_id);
    end if;
    return jsonb_build_object('status','not_found','tracker_id',p_tracker_id);
  end if;
  if p_expected_revision is null then
    raise exception 'expected server revision is required' using errcode='22023';
  end if;
  if v_tracker.server_revision<>p_expected_revision then
    return jsonb_build_object('status','conflict','record',to_jsonb(v_tracker));
  end if;
  if v_tracker.deleted_at is null then
    raise exception 'tracker must be in the Bin before permanent deletion' using errcode='22023';
  end if;
  return public.finalize_tracker_deletion(v_user_id,p_tracker_id,p_operation_id,p_wins_retention);
end;
$$;
revoke all on function public.permanently_delete_tracker(uuid,uuid,uuid,bigint,text) from public,anon;
grant execute on function public.permanently_delete_tracker(uuid,uuid,uuid,bigint,text) to authenticated;

comment on function public.permanently_delete_tracker(uuid,uuid,uuid,bigint,text) is
  'Owner- and revision-checked permanent deletion with explicit Wins retention; safely returns already_deleted from the durable owner tombstone on retries.';

commit;
