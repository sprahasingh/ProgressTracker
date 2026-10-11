-- Short-lived, one-use server authorization for account deletion after a
-- password has been verified by Supabase Auth.
begin;

create table public.account_deletion_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create table public.account_deletion_password_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempt_count smallint not null check (attempt_count between 1 and 6)
);

alter table public.account_deletion_authorizations enable row level security;
alter table public.account_deletion_password_attempts enable row level security;
revoke all on public.account_deletion_authorizations from public, anon, authenticated;
revoke all on public.account_deletion_password_attempts from public, anon, authenticated;
grant all on public.account_deletion_authorizations to service_role;
grant all on public.account_deletion_password_attempts to service_role;

create or replace function public.reserve_account_deletion_password_attempt(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt_count smallint;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null then
    raise exception 'invalid account deletion password attempt' using errcode = '22023';
  end if;

  insert into public.account_deletion_password_attempts as current_attempt(user_id, window_started_at, attempt_count)
  values (p_user_id, v_now, 1)
  on conflict (user_id) do update set
    window_started_at = case
      when current_attempt.window_started_at <= v_now - interval '15 minutes' then v_now
      else current_attempt.window_started_at end,
    attempt_count = case
      when current_attempt.window_started_at <= v_now - interval '15 minutes' then 1
      else least(current_attempt.attempt_count + 1, 6) end
  returning attempt_count into v_attempt_count;

  return v_attempt_count <= 5;
end;
$$;

create or replace function public.issue_account_deletion_authorization(p_user_id uuid, p_token_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid account deletion authorization' using errcode = '22023';
  end if;

  insert into public.account_deletion_authorizations as current_authorization
    (user_id, token_hash, created_at, expires_at, consumed_at)
  values (p_user_id, p_token_hash, v_now, v_now + interval '5 minutes', null)
  on conflict (user_id) do update set
    token_hash = excluded.token_hash,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    consumed_at = null;
end;
$$;

create or replace function public.consume_account_deletion_authorization(p_user_id uuid, p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  update public.account_deletion_authorizations
    set consumed_at = clock_timestamp()
    where user_id = p_user_id and token_hash = p_token_hash
      and consumed_at is null and expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function public.reserve_account_deletion_password_attempt(uuid) from public, anon, authenticated;
revoke all on function public.issue_account_deletion_authorization(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_account_deletion_authorization(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_account_deletion_password_attempt(uuid) to service_role;
grant execute on function public.issue_account_deletion_authorization(uuid, text) to service_role;
grant execute on function public.consume_account_deletion_authorization(uuid, text) to service_role;

commit;
