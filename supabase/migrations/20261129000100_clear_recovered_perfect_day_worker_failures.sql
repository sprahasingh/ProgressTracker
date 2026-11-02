-- A recovered account must clear its private worker diagnostic even when the
-- current day is now neutral/failed or its award was already active.
begin;

do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.reconcile_current_perfect_days(integer)'::regprocedure
  );
  v_old text := $old$
            delete from public.progression_perfect_day_worker_failures f where f.user_id=v_user_id;
            v_processed := v_processed+1;
          end if;
        end if;
      end if;
      update public.progression_perfect_day_worker_cursor
$old$;
  v_new text := $new$
            v_processed := v_processed+1;
          end if;
        end if;
      end if;
      delete from public.progression_perfect_day_worker_failures f where f.user_id=v_user_id;
      update public.progression_perfect_day_worker_cursor
$new$;
begin
  if (pg_catalog.length(v_definition)-pg_catalog.length(pg_catalog.replace(v_definition,v_old,'')))
      / pg_catalog.length(v_old) <> 1 then
    raise exception 'Expected exactly one worker success block to patch';
  end if;
  v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$$;

comment on function public.reconcile_current_perfect_days(integer) is
  'Fair, non-overlapping five-minute recovery worker. Evaluates at most 50 configured account-local dates per run, records isolated SQLSTATE failures, and clears diagnostics after any successful account pass.';

commit;
