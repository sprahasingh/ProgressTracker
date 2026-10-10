-- Private per-account throttle for subscription management and an atomic,
-- owner-bound registration/revocation RPC. The five notification domain tables
-- remain unchanged; this table contains only rate-limit counters.
begin;

create table public.notification_subscription_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count smallint not null check (request_count between 1 and 11)
);
alter table public.notification_subscription_rate_limits enable row level security;
revoke all on public.notification_subscription_rate_limits from public, anon, authenticated;

create or replace function public.manage_notification_device(
  p_user_id uuid,
  p_action text,
  p_endpoint text,
  p_p256dh text default null,
  p_auth_secret text default null,
  p_user_agent text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started_at timestamptz;
  v_request_count smallint;
  v_device_id uuid;
  v_active_devices bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_action not in ('register', 'revoke')
     or p_endpoint is null or char_length(p_endpoint) not between 9 and 2048 then
    raise exception 'invalid subscription management request' using errcode = '22023';
  end if;

  insert into public.notification_subscription_rate_limits as current_limit(user_id, window_started_at, request_count)
  values (p_user_id, v_now, 1)
  on conflict (user_id) do update set
    window_started_at = case
      when current_limit.window_started_at <= v_now - interval '1 minute' then v_now
      else current_limit.window_started_at end,
    request_count = case
      when current_limit.window_started_at <= v_now - interval '1 minute' then 1
      else current_limit.request_count + 1 end
  returning window_started_at, request_count into v_window_started_at, v_request_count;

  if v_request_count > 10 then
    raise exception 'subscription management rate limit exceeded' using errcode = 'P0001';
  end if;

  if p_action = 'revoke' then
    update public.notification_devices
      set enabled = false, revoked_at = coalesce(revoked_at, v_now), last_seen_at = v_now
      where user_id = p_user_id and endpoint = p_endpoint;
    -- Do not reveal whether the endpoint existed or belonged to another user.
    return jsonb_build_object('status', 'revoked');
  end if;

  if p_p256dh is null or p_auth_secret is null
     or char_length(p_endpoint) < 9 or (p_expires_at is not null and p_expires_at <= v_now) then
    raise exception 'invalid subscription registration' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('notification-endpoint:' || p_endpoint, 0));

  select count(*) into v_active_devices from public.notification_devices
    where user_id = p_user_id and enabled and revoked_at is null
      and (expires_at is null or expires_at > v_now);
  if not exists (select 1 from public.notification_devices where user_id = p_user_id and endpoint = p_endpoint)
     and v_active_devices >= 20 then
    raise exception 'account device subscription limit reached' using errcode = '54000';
  end if;

  insert into public.notification_devices as existing_device
    (id, user_id, endpoint, p256dh, auth_secret, user_agent, enabled, expires_at, revoked_at, last_seen_at)
  values
    (gen_random_uuid(), p_user_id, p_endpoint, p_p256dh, p_auth_secret, left(p_user_agent, 512), true, p_expires_at, null, v_now)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth_secret = excluded.auth_secret,
    user_agent = excluded.user_agent,
    enabled = true,
    expires_at = excluded.expires_at,
    revoked_at = null,
    last_seen_at = v_now
  where existing_device.user_id = excluded.user_id
  returning id into v_device_id;

  if v_device_id is null then
    raise exception 'subscription is already registered to another account' using errcode = '23505';
  end if;

  return jsonb_build_object('status', 'registered');
end;
$$;
revoke all on function public.manage_notification_device(uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.manage_notification_device(uuid, text, text, text, text, text, timestamptz) to service_role;

comment on table public.notification_subscription_rate_limits is 'Private fixed-window per-account request limits for trusted Web Push subscription management.';
comment on function public.manage_notification_device(uuid, text, text, text, text, text, timestamptz) is 'Service-role-only atomic registration and revocation. Callers must verify the account JWT and supply only its subject as p_user_id.';

commit;
