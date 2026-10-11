-- Keep minute counters bounded to one row per user instead of retaining a row for every minute forever.
delete from public.ai_help_user_rate_limits older
using public.ai_help_user_rate_limits newer
where older.user_id = newer.user_id and older.window_start < newer.window_start;

alter table public.ai_help_user_rate_limits drop constraint ai_help_user_rate_limits_pkey;
alter table public.ai_help_user_rate_limits add primary key (user_id);

create unique index if not exists ai_knowledge_candidates_pending_fingerprint_idx
  on public.ai_knowledge_candidates (question_fingerprint, knowledge_version)
  where status = 'pending';

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
    window_start = v_window,
    request_count = case when public.ai_help_user_rate_limits.window_start = v_window then public.ai_help_user_rate_limits.request_count + 1 else 1 end
  returning request_count into v_user_count;

  insert into public.ai_help_global_rate_limit (singleton, window_start, request_count)
  values (true, v_window, 1)
  on conflict (singleton) do update set
    window_start = v_window,
    request_count = case when public.ai_help_global_rate_limit.window_start = v_window then public.ai_help_global_rate_limit.request_count + 1 else 1 end
  returning request_count into v_global_count;

  return jsonb_build_object('allowed', v_user_count <= 12 and v_global_count <= 300,
    'retryAfterSeconds', 60 - extract(second from now())::integer);
end;
$$;

revoke all on function public.consume_ai_help_request(uuid) from public, anon, authenticated;
grant execute on function public.consume_ai_help_request(uuid) to service_role;
