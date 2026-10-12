begin;

-- Email contact consent and maintainer identity visibility are independent.
-- Preserve the caller's email preference while the identity snapshot continues
-- to be captured from app_settings.share_identity by the existing trigger.
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
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 7319));
    select settings.share_identity into v_share_identity
      from public.app_settings as settings where settings.user_id = new.user_id;
  end if;

  new.share_identity := coalesce(v_share_identity, false);
  return new;
end;
$$;

comment on column public.support_feedback.share_email is
  'Whether the submitter permits support email contact for this request; independent of maintainer identity visibility.';

commit;
