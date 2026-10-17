begin;

-- Existing stored values are treated as chosen so prior opt-outs remain intact.
-- Rows created after this migration leave the marker null until the user saves
-- a choice; those accounts use the new enabled-by-default behavior.
alter table public.app_settings
  add column identity_sharing_preference_set boolean;
alter table public.app_settings
  alter column share_identity set default true;

update public.app_settings
set identity_sharing_preference_set = true;

create or replace function public.mark_identity_sharing_preference_set()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.identity_sharing_preference_set := true;
  return new;
end;
$$;
revoke all on function public.mark_identity_sharing_preference_set() from public, anon, authenticated;
create trigger app_settings_mark_identity_sharing_preference_set
  before update of share_identity on public.app_settings
  for each row execute function public.mark_identity_sharing_preference_set();

create or replace function public.capture_feedback_identity_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share_identity boolean;
  v_preference_set boolean;
begin
  if new.user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 7319));
    select settings.share_identity, settings.identity_sharing_preference_set
      into v_share_identity, v_preference_set
      from public.app_settings as settings where settings.user_id = new.user_id;
  end if;

  -- A missing or unconfigured preference defaults on. Stored preferences are
  -- captured on the submission, so later changes do not affect old reports.
  new.share_identity := new.user_id is not null
    and (v_preference_set is not true or coalesce(v_share_identity, false));
  return new;
end;
$$;
revoke all on function public.capture_feedback_identity_consent() from public, anon, authenticated;
grant execute on function public.capture_feedback_identity_consent() to service_role;

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
  insert into public.app_settings (id, user_id, share_identity, identity_sharing_preference_set, updated_at)
    values ('general', v_user_id, p_share_identity, true, pg_catalog.clock_timestamp())
    on conflict (user_id) do update
      set share_identity = excluded.share_identity,
          identity_sharing_preference_set = true,
          updated_at = excluded.updated_at;

  return p_share_identity;
end;
$$;
revoke all on function public.set_identity_sharing_preference(boolean) from public, anon;
grant execute on function public.set_identity_sharing_preference(boolean) to authenticated;

comment on column public.app_settings.identity_sharing_preference_set is
  'True for preferences stored before the enabled default or explicitly selected by the user; null means use the enabled default.';
comment on column public.app_settings.share_identity is
  'Account-wide consent for maintainers to see account identity on future feedback submissions; true by default when no preference has been saved.';

commit;
