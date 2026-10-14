-- Delete Wins supports only rewards with complete, server-owned attribution.
-- All changes remain in the permanent-deletion transaction. Unknown or legacy
-- account balances are rejected before any reversal or deletion is written.
begin;

create table public.tracker_deletion_reconciliation_context (
  transaction_id bigint not null,
  user_id uuid not null,
  tracker_id uuid not null,
  primary key (transaction_id, user_id, tracker_id)
);
alter table public.tracker_deletion_reconciliation_context enable row level security;
revoke all on public.tracker_deletion_reconciliation_context from public, anon, authenticated, service_role;

create or replace function public.reconcile_progression_achievements_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_tracker_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_user_id := old.user_id;
    if tg_table_name = 'trackers' then v_tracker_id := old.id;
    else v_tracker_id := old.tracker_id; end if;
    if exists (
      select 1 from public.tracker_deletion_reconciliation_context c
      where c.transaction_id = pg_catalog.txid_current()
        and c.user_id = v_user_id and c.tracker_id = v_tracker_id
    ) then
      return old;
    end if;
    perform public.reconcile_progression_achievements(v_user_id);
  end if;
  if tg_op <> 'DELETE' then
    v_user_id := new.user_id;
    if tg_table_name = 'trackers' then v_tracker_id := new.id;
    else v_tracker_id := new.tracker_id; end if;
    if not exists (
      select 1 from public.tracker_deletion_reconciliation_context c
      where c.transaction_id = pg_catalog.txid_current()
        and c.user_id = v_user_id and c.tracker_id = v_tracker_id
    ) then
      perform public.reconcile_progression_achievements(v_user_id);
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.reconcile_progression_achievements_trigger() from public, anon, authenticated, service_role;

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
  v_award public.progression_award_state%rowtype;
  v_existing public.tracker_deletion_ledger%rowtype;
  v_date date;
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
      raise exception 'permanent tracker deletion requires an explicit safe Wins retention choice' using errcode='55000';
    end if;
  elsif p_wins_retention='delete_wins' then
    -- Legacy/reconstructed XP, source-less retained history, and unknown event
    -- types have no exact tracker attribution. Keep the operation fail-closed.
    if exists (
      select 1 from public.progression_events e
      where e.user_id=p_user_id and e.reason_code not in
        ('DAILY_CHECK_IN_COMPLETED','PERFECT_DAY_BONUS','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED','AWARD_REVERSAL')
    ) or exists (
      select 1 from public.progression_events e
      where e.user_id=p_user_id and e.reason_code in ('DAILY_CHECK_IN_COMPLETED','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED')
        and not exists (
          select 1 from public.progression_event_sources s
          join public.progression_award_state a on a.user_id=s.user_id
            and a.tracker_id=s.tracker_id and a.source_id is not distinct from s.source_id
          where s.user_id=e.user_id and s.event_id=e.id and s.tracker_id is not null
            and (e.reason_code <> 'DAILY_CHECK_IN_COMPLETED' or s.source_id is not null)
            and a.reason_code=e.reason_code
        )
    ) or exists (
      select 1 from public.progression_events e
      where e.user_id=p_user_id and e.reason_code='PERFECT_DAY_BONUS'
        and not exists (
          select 1 from public.progression_award_state a
          where a.user_id=e.user_id and a.reason_code='PERFECT_DAY_BONUS'
            and a.effective_date=e.effective_date
        )
    ) or exists (
      select 1 from public.progression_events reversal
      left join public.progression_events original on original.user_id=reversal.user_id and original.id=reversal.reverses_event_id
      where reversal.user_id=p_user_id and reversal.reason_code='AWARD_REVERSAL'
        and (original.id is null or original.reason_code not in
          ('DAILY_CHECK_IN_COMPLETED','PERFECT_DAY_BONUS','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED')
          or reversal.xp_delta <> -original.xp_delta)
    ) or exists (
      select 1 from public.progression_events e
      where e.user_id=p_user_id and e.reason_code in
        ('DAILY_CHECK_IN_COMPLETED','PERFECT_DAY_BONUS','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED')
        and not exists(select 1 from public.progression_events r
          where r.user_id=e.user_id and r.reverses_event_id=e.id)
        and not exists(select 1 from public.progression_award_state a
          where a.user_id=e.user_id and a.current_event_id=e.id and a.current_xp=e.xp_delta
            and a.reason_code=e.reason_code
            and ((e.reason_code='PERFECT_DAY_BONUS' and a.tracker_id is null and a.goal_id is null and a.source_id is null)
              or exists(select 1 from public.progression_event_sources s
                where s.user_id=e.user_id and s.event_id=e.id
                  and s.tracker_id is not distinct from a.tracker_id
                  and s.goal_id is not distinct from a.goal_id
                  and s.source_id is not distinct from a.source_id)))
    ) or exists (
      select 1 from public.progression_award_state a
      where a.user_id=p_user_id and a.tracker_id=p_tracker_id and a.current_xp>0
        and (a.reason_code not in ('DAILY_CHECK_IN_COMPLETED','STREAK_MILESTONE','GOAL_MILESTONE','GOAL_COMPLETED')
          or not exists(select 1 from public.progression_events e where e.user_id=a.user_id and e.id=a.current_event_id
            and e.reason_code=a.reason_code))
    ) or exists (
      select 1 from public.progression_award_state a
      where a.user_id=p_user_id and a.current_xp>0
        and a.reason_code in ('GOAL_MILESTONE','GOAL_COMPLETED') and a.tracker_id is null
    ) then
      raise exception 'Wins history contains reconstructed, incomplete, or unattributed rewards and cannot be removed safely. Choose Keep my Wins history.'
        using errcode='55000';
    end if;

    -- Validate and reverse each active award owned by this tracker while its
    -- source rows still exist. The existing deterministic award keys make this
    -- idempotent, including awards that had already been reversed.
    for v_entry in
      select e.* from public.tracker_entries e
      where e.user_id=p_user_id and e.tracker_id=p_tracker_id order by e.id for update
    loop
      perform public.record_progression_entry_award(
        p_user_id,p_tracker_id,v_entry.id,v_entry.entry_date,v_entry.entry_values,
        v_entry.outcome,clock_timestamp()
      );
    end loop;
    -- Match normal entry-scoring lock order. The streak calculator reads
    -- schedule eligibility but intentionally ignores Bin status, so deletion
    -- explicitly reverses exact tracker-scoped milestone award states.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_user_id::text || ':progression-tracker:' || p_tracker_id::text, 4)
    );
    for v_award in
      select a.* from public.progression_award_state a
      where a.user_id=p_user_id and a.tracker_id=p_tracker_id
        and a.current_xp>0 and a.reason_code='STREAK_MILESTONE'
      order by a.award_key for update
    loop
      perform public.reconcile_progression_award(
        p_user_id,v_award.award_key,v_award.reason_code,v_award.effective_date,
        v_award.current_xp,p_tracker_id,null,v_award.source_id,false,
        'Tracker and its Wins were permanently deleted'
      );
    end loop;

    -- Perfect Day is account/date-scoped, never charged to the deleted
    -- tracker. Re-evaluate only existing active bonuses on dates with target
    -- activity; the routine reverses only if the remaining eligible set fails.
    for v_date in
      select distinct a.effective_date
      from public.progression_award_state a
      join public.tracker_entries e on e.user_id=a.user_id and e.entry_date=a.effective_date
      where a.user_id=p_user_id and a.reason_code='PERFECT_DAY_BONUS' and a.current_xp>0
        and e.tracker_id=p_tracker_id
      order by a.effective_date
    loop
      perform public.reconcile_progression_perfect_day(p_user_id,v_date);
    end loop;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_user_id::text || ':progression-goal-tracker:' || p_tracker_id::text, 7)
    );
    for v_award in
      select a.* from public.progression_award_state a
      where a.user_id=p_user_id and a.tracker_id=p_tracker_id and a.current_xp>0
        and a.reason_code in ('GOAL_MILESTONE','GOAL_COMPLETED')
      order by a.award_key for update
    loop
      perform public.reconcile_progression_award(
        p_user_id,v_award.award_key,v_award.reason_code,v_award.effective_date,
        v_award.current_xp,p_tracker_id,null,v_award.source_id,false,
        'Tracker and its Wins were permanently deleted'
      );
    end loop;
  end if;

  -- Entry and tracker scoring locks have been acquired before the shared
  -- achievement lock, matching the normal sync trigger order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':progression-achievements', 11)
  );
  insert into public.tracker_deletion_reconciliation_context(transaction_id,user_id,tracker_id)
  values(pg_catalog.txid_current(),p_user_id,p_tracker_id) on conflict do nothing;

  if p_wins_retention='keep_wins' then
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

  -- Anonymize achievement references to target score events for either mode;
  -- keep earned dates and append-only unlock/revocation records.
  update public.progression_achievement_events achievement
  set source_event_id=null,
      source_reference='{"source":"tracker deletion"}'::jsonb
  where achievement.user_id=p_user_id and achievement.source_event_id in (
    select source.event_id from public.progression_event_sources source
    where source.user_id=p_user_id and source.tracker_id=p_tracker_id
  );
  update public.progression_achievement_progress progress
  set source_event_id=null
  where progress.user_id=p_user_id and progress.source_event_id in (
    select source.event_id from public.progression_event_sources source
    where source.user_id=p_user_id and source.tracker_id=p_tracker_id
  );

  delete from public.sync_operation_receipts r where r.user_id=p_user_id and (
    (r.entity='tracker' and r.record_payload->>'id'=p_tracker_id::text)
    or (r.entity='tracker_entry' and r.record_payload->>'tracker_id'=p_tracker_id::text)
  );
  delete from public.tracker_entries where user_id=p_user_id and tracker_id=p_tracker_id;
  delete from public.trackers where user_id=p_user_id and id=p_tracker_id;
  delete from public.tracker_deletion_reconciliation_context
  where transaction_id=pg_catalog.txid_current() and user_id=p_user_id and tracker_id=p_tracker_id;
  perform public.reconcile_progression_achievements(p_user_id);

  return jsonb_build_object('status','deleted','tracker_id',p_tracker_id,
    'permanently_deleted_at',clock_timestamp(),'wins_retention',p_wins_retention);
end;
$$;
revoke all on function public.finalize_tracker_deletion(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

comment on function public.finalize_tracker_deletion(uuid,uuid,uuid,text) is
  'Atomically deletes a tracker with exact tracker-scoped XP reversal, shared Perfect Day reconciliation, anonymized achievement history, and fail-closed handling of unattributed balances.';

commit;
