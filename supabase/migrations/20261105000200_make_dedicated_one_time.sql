-- Dedicated is a one-time badge from this policy boundary forward. Keep every
-- historical occurrence and reversal; the earliest tier remains the active
-- achievement state and later legacy tiers remain audit history.
begin;

do $$
declare
  v_definition text;
  v_old text := $old$      ('dedicated', v_qualifying::numeric, 100::numeric, true, 'Each additional 100 server-confirmed qualifying check-ins')$old$;
  v_new text := $new$      ('dedicated', v_qualifying::numeric, 100::numeric, false, 'The first 100 server-confirmed qualifying check-ins')$new$;
  v_revoke_old text := $old$        and u.tier>v_tier$old$;
  v_revoke_new text := $new$        and u.tier>v_tier
        and (v_record.achievement_id <> 'dedicated' or u.tier=1)$new$;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure);
  if pg_catalog.strpos(v_definition, v_old) = 0 or pg_catalog.strpos(v_definition, v_revoke_old) = 0 then
    raise exception 'Expected Dedicated cadence rules were not found in the active base reconciler';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  v_definition := pg_catalog.replace(v_definition, v_revoke_old, v_revoke_new);
  execute v_definition;
end;
$$;

-- The public progress row is authoritative for cadence. Reconciliation below
-- keeps legacy tiers intact while exposing the one-time state as 0 or 1.
update public.progression_achievement_progress p
set repeatable = false,
    target = 100,
    current_tier = case when exists (
      select 1 from public.progression_achievement_events u
      where u.user_id = p.user_id and u.achievement_id = 'dedicated'
        and u.event_type = 'unlocked'
        and not exists (
          select 1 from public.progression_achievement_events r
          where r.user_id = u.user_id and r.reverses_event_id = u.id
        )
    ) then 1 else 0 end,
    updated_at = clock_timestamp()
where p.achievement_id = 'dedicated';

comment on function public.reconcile_progression_achievements_base(uuid) is
  'Reconciles server-authoritative progression badges. Dedicated is one-time; legacy tiers above one are retained as history and are not revoked by cadence migration.';

commit;
