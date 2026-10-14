begin;

create or replace function public.reconcile_progression_achievements(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.reconcile_progression_achievements_before_occurrence_policy(p_user_id);
  if not exists (select 1 from auth.users where id=p_user_id) then return; end if;
  insert into public.progression_achievement_progress(user_id, achievement_id, progress, target, current_tier, repeatable)
  select p_user_id, badge.achievement_id, 0, 1, 0, true
  from (values ('perfect-day'), ('milestone-maker'), ('goal-crusher')) as badge(achievement_id)
  on conflict (user_id, achievement_id) do update set repeatable=true, target=1,
    updated_at=clock_timestamp();
  perform public.reconcile_progression_repeatable_achievements(p_user_id);
end;
$$;
revoke all on function public.reconcile_progression_achievements(uuid) from public, anon, authenticated, service_role;

commit;
