-- Private knowledge and abuse-control storage for the informational AI help endpoint.
create table if not exists public.ai_feature_knowledge (
  slug text primary key,
  title text not null,
  content text not null,
  source_refs jsonb not null default '[]'::jsonb,
  knowledge_version text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_question_memory (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  source_refs jsonb not null default '[]'::jsonb,
  knowledge_version text not null,
  verified_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists public.ai_knowledge_candidates (
  id uuid primary key default gen_random_uuid(),
  question_fingerprint text not null,
  answer text not null,
  source_refs jsonb not null default '[]'::jsonb,
  knowledge_version text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'stale')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_id uuid references auth.users(id) on delete set null
);

create table if not exists public.ai_help_user_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);

create table if not exists public.ai_help_global_rate_limit (
  singleton boolean primary key default true check (singleton),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0)
);

create table if not exists public.ai_help_provider_health (
  provider_slot text primary key check (provider_slot in ('primary', 'secondary')),
  last_status integer,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  disabled_until timestamptz,
  checked_at timestamptz not null default now()
);

alter table public.ai_feature_knowledge enable row level security;
alter table public.ai_question_memory enable row level security;
alter table public.ai_knowledge_candidates enable row level security;
alter table public.ai_help_user_rate_limits enable row level security;
alter table public.ai_help_global_rate_limit enable row level security;
alter table public.ai_help_provider_health enable row level security;

revoke all on public.ai_feature_knowledge, public.ai_question_memory, public.ai_knowledge_candidates,
  public.ai_help_user_rate_limits, public.ai_help_global_rate_limit, public.ai_help_provider_health from public, anon, authenticated;
grant all on public.ai_feature_knowledge, public.ai_question_memory, public.ai_knowledge_candidates,
  public.ai_help_user_rate_limits, public.ai_help_global_rate_limit, public.ai_help_provider_health to service_role;

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
  on conflict (user_id, window_start) do update
    set request_count = public.ai_help_user_rate_limits.request_count + 1
  returning request_count into v_user_count;

  insert into public.ai_help_global_rate_limit (singleton, window_start, request_count)
  values (true, v_window, 1)
  on conflict (singleton) do update set
    window_start = case when public.ai_help_global_rate_limit.window_start = v_window then v_window else v_window end,
    request_count = case when public.ai_help_global_rate_limit.window_start = v_window then public.ai_help_global_rate_limit.request_count + 1 else 1 end
  returning request_count into v_global_count;

  return jsonb_build_object('allowed', v_user_count <= 12 and v_global_count <= 300,
    'retryAfterSeconds', 60 - extract(second from now())::integer);
end;
$$;

revoke all on function public.consume_ai_help_request(uuid) from public, anon, authenticated;
grant execute on function public.consume_ai_help_request(uuid) to service_role;

