begin;

-- Email sharing is optional. Existing records keep their pre-consent behavior;
-- new submissions receive the explicit preference from the server-validated form.
alter table public.support_feedback
  add column share_email boolean not null default true;

create or replace function public.submit_unified_support_feedback(
  p_user_id uuid, p_request_id uuid, p_category text, p_source text,
  p_subject text, p_message text, p_share_email boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_existing public.support_feedback%rowtype; v_count integer;
begin
  if p_user_id is null or p_request_id is null or p_category not in ('support_query','bug_report','feature_request','general_feedback')
    or p_source not in ('settings','ai_help_support','other')
    or p_subject is null or char_length(btrim(p_subject)) not between 1 and 160
    or p_message is null or char_length(btrim(p_message)) not between 1 and 4000
    or p_share_email is null then
    raise exception 'Invalid feedback submission.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 41));
  select * into v_existing from public.support_feedback where user_id = p_user_id and request_id = p_request_id;
  if found then return jsonb_build_object('accepted', true, 'duplicate', true, 'feedback_id', v_existing.id, 'email_status', v_existing.email_status); end if;
  select count(*) into v_count from public.support_feedback where user_id = p_user_id and created_at > now() - interval '15 minutes';
  if v_count >= 5 then raise exception 'Feedback rate limit exceeded.' using errcode = 'P4290'; end if;
  insert into public.support_feedback(user_id, request_id, category, source, subject, original_message, email_status, share_email)
  values (p_user_id, p_request_id, p_category, p_source, btrim(p_subject), btrim(p_message), 'pending', p_share_email)
  returning id into v_id;
  insert into public.support_feedback_email_outbox(feedback_id, event_key)
    values (v_id, 'feedback:' || v_id::text);
  return jsonb_build_object('accepted', true, 'duplicate', false, 'feedback_id', v_id, 'email_status', 'pending');
end $$;

revoke all on function public.submit_unified_support_feedback(uuid,uuid,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.submit_unified_support_feedback(uuid,uuid,text,text,text,text,boolean) to service_role;

comment on column public.support_feedback.share_email is 'Whether the user consented to share their account email with support for direct contact. In-app replies do not depend on this preference.';

commit;
