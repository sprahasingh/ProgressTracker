-- Recompute only the three current calendar period details when the user
-- refreshes progression. Historical Perfect Day work remains owned by the
-- bounded background queue; this RPC only evaluates the current week/month/year.
begin;

create or replace function public.refresh_my_progression_qualification_progress()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_due_dates_pending boolean;
  v_tracker_jobs_pending boolean;
  v_backfill_pending boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;

  insert into public.progression_achievement_accounts(user_id,initialized_at)
    select v_user_id,initialized_at from public.progression_account_state where user_id=v_user_id
    on conflict(user_id) do nothing;

  -- Rebuild current-period status/progress from date-effective server rules.
  -- This is bounded by calendar period lengths and does not reconcile awards.
  perform public.refresh_progression_perfect_period_details(v_user_id);

  select exists(
    select 1
    from public.progression_perfect_day_repair_queue q
    join public.app_settings s on s.user_id=q.user_id
    where q.user_id=v_user_id and q.entry_date<=public.progression_local_date(clock_timestamp(),
      case when exists(select 1 from pg_catalog.pg_timezone_names z where z.name=s.timezone)
        then s.timezone else 'UTC' end)
  ) into v_due_dates_pending;
  select exists(
    select 1 from public.progression_perfect_day_tracker_jobs j where j.user_id=v_user_id
  ) into v_tracker_jobs_pending;
  select exists(
    select 1 from public.progression_perfect_day_backfill_state b
    join public.tracker_entries e on e.user_id=v_user_id
      and e.id>coalesce(b.last_entry_id,'00000000-0000-0000-0000-000000000000'::uuid)
      and e.id<=b.upper_entry_id
    where b.singleton and b.completed_at is null
  ) into v_backfill_pending;

  -- Period status and history verification are independent dimensions. Apply
  -- pending metadata after recomputation so it is preserved beside failed or
  -- unavailable period status rather than changing that status.
  update public.progression_achievement_progress
  set qualification_details = (qualification_details - 'pending_dates') || jsonb_build_object(
    'pending_reconciliation', v_due_dates_pending or v_tracker_jobs_pending or v_backfill_pending,
    'pending_message', case
      when v_backfill_pending then 'Historical verification is scanning saved check-ins in the background.'
      when v_due_dates_pending then 'Historical dates are queued for server verification.'
      when v_tracker_jobs_pending then 'Historical tracker changes are being staged for server verification.'
      else null end),
    updated_at=clock_timestamp()
  where user_id=v_user_id and achievement_id in ('perfect-week','perfect-month','perfect-year');
end;
$$;
revoke all on function public.refresh_my_progression_qualification_progress() from public, anon, authenticated, service_role;
grant execute on function public.refresh_my_progression_qualification_progress() to authenticated;

comment on function public.refresh_my_progression_qualification_progress() is
  'Refreshes the authenticated owner’s current Perfect Week/Month/Year details and reports bounded historical queue state without scanning or reconciling historical awards.';

commit;
