-- Add explicit Wins retention choices to permanent tracker deletion. The
-- existing 01500 guard remains in place and only accepts a deletion after a
-- validated mode has been written to the private deletion ledger.
begin;

alter table public.tracker_deletion_ledger
  add column wins_retention text not null default 'legacy_unselected'
  check (wins_retention in ('legacy_unselected','keep_wins','delete_wins'));

create table public.progression_retained_achievement_unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_event_id uuid not null,
  retained_at timestamptz not null default clock_timestamp(),
  primary key (user_id, achievement_event_id),
  foreign key (user_id, achievement_event_id)
    references public.progression_achievement_events(user_id, id) on delete cascade
);
alter table public.progression_retained_achievement_unlocks enable row level security;
revoke all on public.progression_retained_achievement_unlocks from public, anon, authenticated, service_role;
grant select on public.progression_retained_achievement_unlocks to authenticated;
create policy progression_retained_unlocks_select_own on public.progression_retained_achievement_unlocks
  for select to authenticated using ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.guard_tracker_deletion_with_progression_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Account deletion still relies on its existing cascading foreign keys.
  if pg_trigger_depth() > 1 then return old; end if;

  -- Only the internal finalizer can create this private authorization row.
  if exists (
    select 1 from public.tracker_deletion_ledger l
    where l.user_id = old.user_id and l.tracker_id = old.id
      and l.wins_retention in ('keep_wins','delete_wins')
  ) then return old; end if;

  if exists (select 1 from public.progression_events e where e.user_id = old.user_id)
     or exists (select 1 from public.progression_achievement_events e where e.user_id = old.user_id) then
    raise exception 'permanent tracker deletion requires an explicit safe Wins retention choice'
      using errcode = '55000';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_tracker_deletion_with_progression_history() from public, anon, authenticated, service_role;

create or replace function public.prevent_revoking_retained_achievement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type = 'revoked' and exists (
    select 1 from public.progression_retained_achievement_unlocks r
    where r.user_id = new.user_id and r.achievement_event_id = new.reverses_event_id
  ) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_revoking_retained_achievement() from public, anon, authenticated, service_role;
drop trigger if exists progression_prevent_retained_achievement_revocation on public.progression_achievement_events;
create trigger progression_prevent_retained_achievement_revocation
before insert on public.progression_achievement_events
for each row execute function public.prevent_revoking_retained_achievement();

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
    -- This release can reverse exact per-entry awards only. Account-wide
    -- reconstructed XP, shared rewards, goal rewards, or any achievement
    -- history makes Option B unsupported and aborts before changing data.
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
         where a.user_id=p_user_id and a.tracker_id=p_tracker_id and e.id is null
       ) then
      raise exception 'Wins history cannot be removed safely because this account has reconstructed, shared, goal, achievement, or unattributed rewards. Choose Keep my Wins history.'
        using errcode='55000';
    end if;

    -- Reconcile every source while the tracker and entries still exist. The
    -- entry award routine appends at most one reversal per active award.
    for v_entry in select * from public.tracker_entries
      where user_id=p_user_id and tracker_id=p_tracker_id order by id for update
    loop
      perform public.record_progression_entry_award(
        p_user_id,p_tracker_id,v_entry.id,v_entry.entry_date,v_entry.entry_values,
        v_entry.outcome,clock_timestamp()
      );
    end loop;
  else
    -- Preserve current unlocks as account-level historical accomplishments.
    -- The marker is independent of tracker identity and prevents later
    -- reconciliation from revoking a retained historical unlock.
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

-- Preserve the old internal signature for callers not yet able to express a
-- choice. It remains fail-closed for accounts with progression history.
create or replace function public.finalize_tracker_deletion(p_user_id uuid,p_tracker_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.finalize_tracker_deletion(p_user_id,p_tracker_id,p_operation_id,'legacy_unselected');
end;
$$;
revoke all on function public.finalize_tracker_deletion(uuid,uuid,uuid) from public,anon,authenticated,service_role;

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
  if p_operation_id is null or p_tracker_id is null or p_expected_revision is null then
    raise exception 'deletion operation, tracker, and expected revision are required' using errcode='22023';
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

-- Automatic expiry follows the disclosed Keep Wins policy. The protected
-- cleanup switch is intentionally left disabled by migration 01500.
create or replace function public.purge_expired_tracker_bin()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_tracker record; v_count integer:=0;
begin
  if not coalesce((select enabled from public.tracker_deletion_cleanup_control where id),false) then return 0; end if;
  for v_tracker in select user_id,id from public.trackers
    where deleted_at<=clock_timestamp()-interval '30 days' order by deleted_at,id limit 500
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tracker.user_id::text||':'||v_tracker.id::text,0));
    perform public.finalize_tracker_deletion(v_tracker.user_id,v_tracker.id,gen_random_uuid(),'keep_wins');
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.purge_expired_tracker_bin() from public,anon,authenticated;
grant execute on function public.purge_expired_tracker_bin() to postgres, supabase_admin;

comment on table public.progression_retained_achievement_unlocks is
  'Private account-level markers preserving achievements after an explicitly selected Keep Wins tracker deletion.';
comment on function public.finalize_tracker_deletion(uuid,uuid,uuid,text) is
  'Atomically finalizes tracker deletion after explicit Wins retention selection and safe authoritative reconciliation.';

commit;
