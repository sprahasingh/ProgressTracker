begin;

-- Identity consent is account-wide, synchronized in Supabase, and fail-closed.
alter table public.app_settings
  add column share_identity boolean not null default false;

-- Per-submission snapshots prevent enabling the global preference from
-- retroactively identifying older reports. Existing rows remain anonymous.
alter table public.ai_help_answer_feedback
  add column share_identity boolean not null default false;
alter table public.support_feedback
  add column share_identity boolean not null default false;

-- The previous email checkbox defaulted on, so it is not evidence of consent.
update public.support_feedback set share_email = false;

create or replace function public.capture_feedback_identity_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share_identity boolean := false;
begin
  if new.user_id is not null then
    -- Serialize preference changes with submission snapshots so a disable
    -- cannot race with an insert and leave a newly disclosed record behind.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 7319));
    select settings.share_identity into v_share_identity
      from public.app_settings as settings where settings.user_id = new.user_id;
  end if;

  new.share_identity := coalesce(v_share_identity, false);
  if tg_table_name = 'support_feedback' then
    -- Email notifications and inbox email visibility follow the same consent
    -- snapshot. Keep the existing direct-contact path available after opt-in.
    new.share_email := coalesce(new.share_email, false) and new.share_identity;
  end if;
  return new;
end;
$$;
revoke all on function public.capture_feedback_identity_consent() from public, anon, authenticated;
grant execute on function public.capture_feedback_identity_consent() to service_role;

create trigger ai_help_answer_feedback_identity_consent
  before insert on public.ai_help_answer_feedback
  for each row execute function public.capture_feedback_identity_consent();
create trigger support_feedback_identity_consent
  before insert on public.support_feedback
  for each row execute function public.capture_feedback_identity_consent();

-- app_settings remains writable through its existing owner-only RLS policy.
-- Enforce withdrawal even if another supported client updates the row without
-- calling the RPC below.
create or replace function public.withdraw_feedback_identity_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.share_identity and not new.share_identity then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 7319));
    update public.ai_help_answer_feedback
      set share_identity = false where user_id = new.user_id and share_identity;
    update public.support_feedback
      set share_identity = false, share_email = false
      where user_id = new.user_id and (share_identity or share_email);
  end if;
  return new;
end;
$$;
revoke all on function public.withdraw_feedback_identity_consent() from public, anon, authenticated;
grant execute on function public.withdraw_feedback_identity_consent() to service_role;
create trigger app_settings_withdraw_feedback_identity
  after update of share_identity on public.app_settings
  for each row when (old.share_identity and not new.share_identity)
  execute function public.withdraw_feedback_identity_consent();

create or replace function public.set_identity_sharing_preference(p_share_identity boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Sign in to update privacy settings.' using errcode = '42501';
  end if;
  if p_share_identity is null then
    raise exception 'Choose whether to share your identity.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 7319));
  insert into public.app_settings (id, user_id, share_identity, updated_at)
    values ('general', v_user_id, p_share_identity, pg_catalog.clock_timestamp())
    on conflict (user_id) do update
      set share_identity = excluded.share_identity,
          updated_at = excluded.updated_at;

  -- The app_settings update trigger withdraws existing consented submissions
  -- atomically, including writes made by clients that use the owner RLS policy.
  return p_share_identity;
end;
$$;
revoke all on function public.set_identity_sharing_preference(boolean) from public, anon;
grant execute on function public.set_identity_sharing_preference(boolean) to authenticated;

comment on column public.app_settings.share_identity is
  'Account-wide consent for maintainers to see account identity on future feedback submissions; false by default.';
comment on column public.ai_help_answer_feedback.share_identity is
  'Identity-sharing consent captured when this report was submitted; false for historical reports and withdrawn consent.';
comment on column public.support_feedback.share_identity is
  'Identity-sharing consent captured when this request was submitted; false for historical requests and withdrawn consent.';

commit;
