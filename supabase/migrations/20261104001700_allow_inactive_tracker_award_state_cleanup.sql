-- Zero-value historical award-state rows can outlive an entry after earlier
-- reconciliation. They carry no XP to reverse and are anonymized by the
-- existing tracker-delete trigger. Only an active, unattributed award blocks
-- Delete Wins. This is forward-only because migration 016 is already applied
-- in local development.
begin;

create or replace function public.finalize_tracker_deletion(
  p_user_id uuid, p_tracker_id uuid, p_operation_id uuid, p_wins_retention text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers%rowtype;
  v_entry public.tracker_entries%rowtype;
  v_existing public.tracker_deletion_ledger%rowtype;
begin
  if p_wins_retention is null or p_wins_retention not in ('legacy_unselected','keep_wins','delete_wins') then
    raise exception 'a valid Wins retention choice is required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || p_tracker_id::text, 0));
  select * into v_existing from public.tracker_deletion_ledger
  where user_id=p_user_id and tracker_id=p_tracker_id;
  if found then
    return jsonb_build_object('status','already_deleted','tracker_id',p_tracker_id,
      'permanently_deleted_at',v_existing.permanently_deleted_at,'wins_retention',v_existing.wins_retention);
  end if;
  select * into v_tracker from public.trackers
  where user_id=p_user_id and id=p_tracker_id for update;
  if not found then return jsonb_build_object('status','not_found','tracker_id',p_tracker_id); end if;
  if v_tracker.deleted_at is null then
    raise exception 'tracker must be in the Bin before permanent deletion' using errcode = '22023';
  end if;

  if p_wins_retention='legacy_unselected' then
    if exists(select 1 from public.progression_events e where e.user_id=p_user_id)
       or exists(select 1 from public.progression_achievement_events a where a.user_id=p_user_id) then
      raise exception 'permanent tracker deletion requires an explicit safe Wins retention choice'
        using errcode='55000';
    end if;
  elsif p_wins_retention='delete_wins' then
    if exists (select 1 from public.progression_events e where e.user_id=p_user_id
      and e.reason_code not in ('DAILY_CHECK_IN_COMPLETED','AWARD_REVERSAL'))
       or exists (select 1 from public.progression_achievement_events a where a.user_id=p_user_id)
       or exists (
         select 1 from public.progression_events e
         where e.user_id=p_user_id and e.reason_code='DAILY_CHECK_IN_COMPLETED'
           and not exists (
             select 1 from public.progression_event_sources s
             join public.progression_award_state a on a.user_id=s.user_id
               and a.tracker_id=s.tracker_id and a.source_id=s.source_id
             where s.user_id=e.user_id and s.event_id=e.id and s.tracker_id is not null
               and s.source_id is not null
           )
       )
       or exists (
         select 1 from public.progression_events reversal
         where reversal.user_id=p_user_id and reversal.reason_code='AWARD_REVERSAL'
           and not exists (
             select 1 from public.progression_events original
             join public.progression_event_sources s on s.user_id=original.user_id and s.event_id=original.id
             join public.progression_award_state a on a.user_id=s.user_id
               and a.tracker_id=s.tracker_id and a.source_id=s.source_id
             where original.user_id=reversal.user_id and original.id=reversal.reverses_event_id
           )
       )
       or exists (
         select 1 from public.progression_award_state a
         left join public.tracker_entries e on e.user_id=a.user_id and e.tracker_id=a.tracker_id and e.id=a.source_id
         where a.user_id=p_user_id and a.tracker_id=p_tracker_id
           and a.current_xp > 0 and e.id is null
       ) then
      raise exception 'Wins history cannot be removed safely because this account has reconstructed, shared, goal, achievement, or unattributed rewards. Choose Keep my Wins history.'
        using errcode='55000';
    end if;
    for v_entry in select * from public.tracker_entries
      where user_id=p_user_id and tracker_id=p_tracker_id order by id for update
    loop
      perform public.record_progression_entry_award(
        p_user_id,p_tracker_id,v_entry.id,v_entry.entry_date,v_entry.entry_values,
        v_entry.outcome,clock_timestamp()
      );
    end loop;
  else
    insert into public.progression_retained_achievement_unlocks(user_id,achievement_event_id)
    select u.user_id,u.id from public.progression_achievement_events u
    where u.user_id=p_user_id and u.event_type='unlocked'
      and not exists(select 1 from public.progression_achievement_events r
        where r.user_id=u.user_id and r.event_type='revoked' and r.reverses_event_id=u.id)
    on conflict do nothing;
  end if;

  insert into public.tracker_deletion_ledger(user_id,tracker_id,deletion_operation_id,wins_retention)
  values(p_user_id,p_tracker_id,p_operation_id,p_wins_retention)
  on conflict(user_id,tracker_id) do nothing;
  delete from public.sync_operation_receipts r where r.user_id=p_user_id and (
    (r.entity='tracker' and r.record_payload->>'id'=p_tracker_id::text)
    or (r.entity='tracker_entry' and r.record_payload->>'tracker_id'=p_tracker_id::text)
  );
  delete from public.tracker_entries where user_id=p_user_id and tracker_id=p_tracker_id;
  delete from public.trackers where user_id=p_user_id and id=p_tracker_id;
  return jsonb_build_object('status','deleted','tracker_id',p_tracker_id,
    'permanently_deleted_at',clock_timestamp(),'wins_retention',p_wins_retention);
end;
$$;
revoke all on function public.finalize_tracker_deletion(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

comment on function public.finalize_tracker_deletion(uuid,uuid,uuid,text) is
  'Atomically finalizes explicit Wins retention; Delete Wins requires exact live XP attribution, while zero-value stale award state can be anonymized safely.';

commit;
