-- Keep the conflict target required by consume_ai_help_request available and
-- refresh PostgREST's RPC schema cache after the function/grant are installed.
do $$
begin
  if not exists (
    select 1
    from pg_index index_info
    join pg_attribute column_info
      on column_info.attrelid = index_info.indrelid
     and column_info.attnum = index_info.indkey[0]
    where index_info.indrelid = 'public.ai_help_user_rate_limits'::regclass
      and index_info.indisunique
      and index_info.indnkeyatts = 1
      and column_info.attname = 'user_id'
  ) then
    create unique index ai_help_user_rate_limits_user_id_uidx
      on public.ai_help_user_rate_limits (user_id);
  end if;
end;
$$;

create or replace function public.consume_ai_help_request(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_user_count integer;
  v_global_count integer;
begin
  insert into public.ai_help_user_rate_limits (user_id, window_start, request_count)
  values (p_user_id, v_window, 1)
  on conflict (user_id) do update set
    window_start = excluded.window_start,
    request_count = case
      when public.ai_help_user_rate_limits.window_start = excluded.window_start
        then public.ai_help_user_rate_limits.request_count + 1
      else 1
    end
  returning request_count into v_user_count;

  insert into public.ai_help_global_rate_limit (singleton, window_start, request_count)
  values (true, v_window, 1)
  on conflict (singleton) do update set
    window_start = excluded.window_start,
    request_count = case
      when public.ai_help_global_rate_limit.window_start = excluded.window_start
        then public.ai_help_global_rate_limit.request_count + 1
      else 1
    end
  returning request_count into v_global_count;

  return jsonb_build_object(
    'allowed', v_user_count <= 8 and v_global_count <= 24,
    'retryAfterSeconds', 60 - extract(second from now())::integer
  );
end;
$$;

revoke all on function public.consume_ai_help_request(uuid) from public, anon, authenticated;
grant execute on function public.consume_ai_help_request(uuid) to service_role;

notify pgrst, 'reload schema';
