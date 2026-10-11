begin;

-- Store only idempotency/rate-limit metadata. Feedback text is sent to the
-- provider and is not persisted in the ProgressTracker database.
create table public.support_feedback_send_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  rate_window_started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  attempt_count integer not null default 1 check (attempt_count > 0),
  delivery_state text not null default 'processing' check (delivery_state in ('processing', 'accepted', 'rejected', 'uncertain')),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (user_id, request_id)
);

create index support_feedback_send_attempts_rate_idx
  on public.support_feedback_send_attempts (user_id, rate_window_started_at);
create index support_feedback_send_attempts_expiry_idx
  on public.support_feedback_send_attempts (expires_at);

alter table public.support_feedback_send_attempts enable row level security;
revoke all on public.support_feedback_send_attempts from public, anon, authenticated;
grant all on public.support_feedback_send_attempts to service_role;

create or replace function public.begin_support_feedback_submission(p_user_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_accepted_at timestamptz;
  v_delivery_state text;
  v_updated_at timestamptz;
  v_first_attempt timestamptz;
  v_count integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid feedback request.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  delete from public.support_feedback_send_attempts where expires_at <= v_now;

  select accepted_at, delivery_state, updated_at into v_accepted_at, v_delivery_state, v_updated_at
  from public.support_feedback_send_attempts
  where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_delivery_state = 'accepted' or v_accepted_at is not null then
      return jsonb_build_object('allowed', true, 'duplicate', true, 'accepted', true);
    end if;
    if v_delivery_state = 'uncertain' then
      return jsonb_build_object('allowed', false, 'duplicate', true, 'uncertain', true);
    end if;
    if v_delivery_state = 'processing' then
      if v_updated_at <= v_now - interval '2 minutes' then
        update public.support_feedback_send_attempts
        set delivery_state = 'uncertain', updated_at = v_now
        where user_id = p_user_id and request_id = p_request_id;
        return jsonb_build_object('allowed', false, 'duplicate', true, 'uncertain', true);
      end if;
      return jsonb_build_object('allowed', false, 'duplicate', true, 'processing', true);
    end if;

    select coalesce(sum(attempt_count), 0)::integer, min(rate_window_started_at) into v_count, v_first_attempt
    from public.support_feedback_send_attempts
    where user_id = p_user_id and rate_window_started_at > v_now - interval '15 minutes';
    if v_count >= 5 then
      return jsonb_build_object('allowed', false, 'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_first_attempt + interval '15 minutes' - v_now)))::integer));
    end if;

    update public.support_feedback_send_attempts
    set attempt_count = case when rate_window_started_at > v_now - interval '15 minutes' then attempt_count + 1 else 1 end,
        rate_window_started_at = case when rate_window_started_at > v_now - interval '15 minutes' then rate_window_started_at else v_now end,
        created_at = v_now, delivery_state = 'processing', updated_at = v_now
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('allowed', true, 'duplicate', true, 'accepted', false, 'processing', false);
  end if;

  select coalesce(sum(attempt_count), 0)::integer, min(rate_window_started_at) into v_count, v_first_attempt
  from public.support_feedback_send_attempts
  where user_id = p_user_id and rate_window_started_at > v_now - interval '15 minutes';
  if v_count >= 5 then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_first_attempt + interval '15 minutes' - v_now)))::integer));
  end if;

  insert into public.support_feedback_send_attempts(user_id, request_id, created_at, rate_window_started_at, expires_at, updated_at)
  values (p_user_id, p_request_id, v_now, v_now, v_now + interval '30 days', v_now);
  return jsonb_build_object('allowed', true, 'duplicate', false, 'accepted', false);
end;
$$;

create or replace function public.complete_support_feedback_submission(p_user_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.support_feedback_send_attempts
  set accepted_at = coalesce(accepted_at, clock_timestamp()), delivery_state = 'accepted', updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id and delivery_state in ('processing', 'uncertain');
  if not found then raise exception 'Feedback request reservation not found.' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.resolve_support_feedback_submission(p_user_id uuid, p_request_id uuid, p_delivery_state text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_delivery_state not in ('rejected', 'uncertain') then
    raise exception 'Invalid feedback delivery state.' using errcode = '22023';
  end if;
  update public.support_feedback_send_attempts
  set delivery_state = p_delivery_state, updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id and delivery_state = 'processing';
  if not found then raise exception 'Feedback request reservation not found.' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.begin_support_feedback_submission(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_support_feedback_submission(uuid, uuid) to service_role;
revoke all on function public.complete_support_feedback_submission(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_support_feedback_submission(uuid, uuid) to service_role;
revoke all on function public.resolve_support_feedback_submission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_support_feedback_submission(uuid, uuid, text) to service_role;

commit;
