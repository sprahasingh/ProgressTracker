begin;

-- Durable, user-owned feedback and support threads. User references are nulled
-- on account deletion so operational feedback can be retained without identity.
create table public.support_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  request_id uuid,
  category text not null check (category in ('support_query','bug_report','feature_request','general_feedback','ai_answer_feedback')),
  source text not null check (source in ('settings','ai_help_support','ai_help_answer','other')),
  subject text not null check (char_length(btrim(subject)) between 1 and 160),
  original_message text not null check (char_length(btrim(original_message)) between 1 and 4000),
  status text not null default 'open' check (status in ('open','in_progress','waiting_for_user','resolved')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  email_status text not null default 'not_required' check (email_status in ('not_required','pending','accepted','failed','uncertain')),
  maintainer_seen_at timestamptz,
  maintainer_seen_by uuid references auth.users(id) on delete set null,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_feedback_request_owner_unique unique(user_id, request_id)
);

create table public.support_feedback_messages (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.support_feedback(id) on delete cascade,
  sender_user_id uuid references auth.users(id) on delete set null,
  sender_role text not null check (sender_role in ('user','maintainer')),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(feedback_id, sender_role, request_id)
);

create table public.support_feedback_email_outbox (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.support_feedback(id) on delete cascade,
  message_id uuid references public.support_feedback_messages(id) on delete cascade,
  event_key text not null unique,
  status text not null default 'pending' check (status in ('pending','processing','accepted','failed','uncertain')),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 10),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index support_feedback_owner_activity_idx on public.support_feedback(user_id, last_activity_at desc);
create index support_feedback_status_activity_idx on public.support_feedback(status, last_activity_at desc);
create index support_feedback_category_activity_idx on public.support_feedback(category, last_activity_at desc);
create unique index support_feedback_legacy_answer_id_unique on public.support_feedback((metadata->>'legacy_answer_feedback_id'))
  where metadata ? 'legacy_answer_feedback_id';
create index support_feedback_messages_thread_idx on public.support_feedback_messages(feedback_id, created_at);
create index support_feedback_outbox_pending_idx on public.support_feedback_email_outbox(created_at) where status = 'pending';

alter table public.support_feedback enable row level security;
alter table public.support_feedback_messages enable row level security;
alter table public.support_feedback_email_outbox enable row level security;
revoke all on public.support_feedback, public.support_feedback_messages, public.support_feedback_email_outbox from public, anon, authenticated;
grant select on public.support_feedback, public.support_feedback_messages to authenticated;
grant all on public.support_feedback, public.support_feedback_messages, public.support_feedback_email_outbox to service_role;
create policy support_feedback_select_own on public.support_feedback for select to authenticated
  using (user_id = (select auth.uid()));
create policy support_feedback_messages_select_own on public.support_feedback_messages for select to authenticated
  using (exists (select 1 from public.support_feedback f where f.id = feedback_id and f.user_id = (select auth.uid())));

-- Existing answer reports remain intact and are copied once into the unified
-- inbox. Their original table remains available for compatibility and metrics.
insert into public.support_feedback(user_id, category, source, subject, original_message, status, metadata, email_status, last_activity_at, created_at, updated_at)
select f.user_id, 'ai_answer_feedback', 'ai_help_answer',
       'AI Help answer: ' || f.category,
       coalesce(nullif(btrim(f.explanation), ''), 'The user marked an AI Help answer as ' || replace(f.category, '_', ' ') || '.'),
       case when f.status = 'resolved' then 'resolved' when f.status = 'reviewed' then 'in_progress' else 'open' end,
       jsonb_build_object('legacy_answer_feedback_id', f.id, 'response_id', f.response_id, 'answer_category', f.category, 'explanation', f.explanation, 'topic', f.topic, 'knowledge_version', f.knowledge_version, 'legacy_status', f.status),
       'not_required',
       coalesce(f.reviewed_at, f.created_at), f.created_at, coalesce(f.reviewed_at, f.created_at)
from public.ai_help_answer_feedback f
where not exists (select 1 from public.support_feedback u where u.metadata->>'legacy_answer_feedback_id' = f.id::text);

create or replace function public.submit_unified_support_feedback(
  p_user_id uuid, p_request_id uuid, p_category text, p_source text,
  p_subject text, p_message text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_existing public.support_feedback%rowtype; v_count integer;
begin
  if p_user_id is null or p_request_id is null or p_category not in ('support_query','bug_report','feature_request','general_feedback')
    or p_source not in ('settings','ai_help_support','other')
    or p_subject is null or char_length(btrim(p_subject)) not between 1 and 160
    or p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Invalid feedback submission.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 41));
  select * into v_existing from public.support_feedback where user_id = p_user_id and request_id = p_request_id;
  if found then return jsonb_build_object('accepted', true, 'duplicate', true, 'feedback_id', v_existing.id, 'email_status', v_existing.email_status); end if;
  select count(*) into v_count from public.support_feedback where user_id = p_user_id and created_at > now() - interval '15 minutes';
  if v_count >= 5 then raise exception 'Feedback rate limit exceeded.' using errcode = 'P4290'; end if;
  insert into public.support_feedback(user_id, request_id, category, source, subject, original_message, email_status)
  values (p_user_id, p_request_id, p_category, p_source, btrim(p_subject), btrim(p_message),
          case when p_category = 'general_feedback' then 'pending' else 'pending' end)
  returning id into v_id;
  insert into public.support_feedback_email_outbox(feedback_id, event_key)
    values (v_id, 'feedback:' || v_id::text);
  return jsonb_build_object('accepted', true, 'duplicate', false, 'feedback_id', v_id, 'email_status', 'pending');
end $$;

create or replace function public.submit_unified_ai_answer_feedback(
  p_user_id uuid, p_response_id uuid, p_category text, p_explanation text,
  p_topic text, p_knowledge_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_legacy_id uuid; v_feedback_id uuid; v_duplicate boolean;
begin
  v_result := public.submit_ai_help_answer_feedback(p_user_id, p_response_id, p_category, p_explanation, p_topic, p_knowledge_version);
  v_legacy_id := (v_result->>'feedback_id')::uuid;
  v_duplicate := coalesce((v_result->>'duplicate')::boolean, false);
  insert into public.support_feedback(user_id, category, source, subject, original_message, status, metadata, email_status, created_at, last_activity_at)
  select p_user_id, 'ai_answer_feedback', 'ai_help_answer', 'AI Help answer: ' || p_category,
         coalesce(nullif(btrim(p_explanation), ''), 'The user marked an AI Help answer as ' || replace(p_category, '_', ' ') || '.'),
         'open', jsonb_build_object('legacy_answer_feedback_id', old.id, 'response_id', old.response_id, 'answer_category', old.category, 'explanation', old.explanation, 'topic', old.topic, 'knowledge_version', old.knowledge_version, 'legacy_status', old.status),
         case when p_category = 'helpful' then 'not_required' else 'pending' end, old.created_at, old.created_at
  from public.ai_help_answer_feedback old where old.id = v_legacy_id
  on conflict do nothing returning id into v_feedback_id;
  if v_feedback_id is null then
    select id into v_feedback_id from public.support_feedback where metadata->>'legacy_answer_feedback_id' = v_legacy_id::text limit 1;
  end if;
  if exists (select 1 from public.ai_help_answer_feedback where id = v_legacy_id and category <> 'helpful') and v_feedback_id is not null then
    insert into public.support_feedback_email_outbox(feedback_id, event_key) values (v_feedback_id, 'feedback:' || v_feedback_id::text) on conflict do nothing;
  end if;
  return v_result || jsonb_build_object('unified_feedback_id', v_feedback_id, 'duplicate', v_duplicate);
end $$;

create or replace function public.support_user_reply(p_user_id uuid, p_feedback_id uuid, p_request_id uuid, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_feedback public.support_feedback%rowtype; v_message_id uuid;
begin
  if p_user_id is null or p_feedback_id is null or p_request_id is null or p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Enter a reply between 1 and 4,000 characters.' using errcode = '22023';
  end if;
  select * into v_feedback from public.support_feedback where id = p_feedback_id and user_id = p_user_id for update;
  if not found then raise exception 'Support conversation not found.' using errcode = 'P0002'; end if;
  if v_feedback.status = 'resolved' then raise exception 'Resolved conversations cannot be reopened. Start a new support query.' using errcode = '55000'; end if;
  if exists (select 1 from public.support_feedback_messages where feedback_id = p_feedback_id and sender_role = 'user' and request_id = p_request_id) then
    return jsonb_build_object('accepted', true, 'duplicate', true);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 42));
  if (select count(*) from public.support_feedback_messages where sender_user_id = p_user_id and sender_role = 'user' and created_at > now() - interval '15 minutes') >= 10 then
    raise exception 'Reply rate limit exceeded.' using errcode = 'P4290';
  end if;
  insert into public.support_feedback_messages(feedback_id, sender_user_id, sender_role, body, request_id)
  values (p_feedback_id, p_user_id, 'user', btrim(p_message), p_request_id)
  on conflict (feedback_id, sender_role, request_id) do nothing returning id into v_message_id;
  if v_message_id is null then return jsonb_build_object('accepted', true, 'duplicate', true); end if;
  update public.support_feedback set status = 'open', last_activity_at = now(), updated_at = now(), email_status = 'pending' where id = p_feedback_id;
  insert into public.support_feedback_email_outbox(feedback_id, message_id, event_key)
    values (p_feedback_id, v_message_id, 'reply:' || v_message_id::text) on conflict do nothing;
  return jsonb_build_object('accepted', true, 'duplicate', false, 'message_id', v_message_id);
end $$;

create or replace function public.support_maintainer_reply(p_maintainer_id uuid, p_feedback_id uuid, p_request_id uuid, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_feedback public.support_feedback%rowtype; v_message_id uuid; v_title text;
begin
  if p_maintainer_id is null or p_feedback_id is null or p_request_id is null or p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Enter a reply between 1 and 4,000 characters.' using errcode = '22023';
  end if;
  select * into v_feedback from public.support_feedback where id = p_feedback_id for update;
  if not found then raise exception 'Support conversation not found.' using errcode = 'P0002'; end if;
  if v_feedback.status = 'resolved' then raise exception 'Resolved conversations cannot be reopened. Change the status before replying.' using errcode = '55000'; end if;
  insert into public.support_feedback_messages(feedback_id, sender_user_id, sender_role, body, request_id)
  values (p_feedback_id, p_maintainer_id, 'maintainer', btrim(p_message), p_request_id)
  on conflict (feedback_id, sender_role, request_id) do nothing returning id into v_message_id;
  if v_message_id is null then return jsonb_build_object('accepted', true, 'duplicate', true); end if;
  update public.support_feedback set status = 'waiting_for_user', last_activity_at = now(), updated_at = now() where id = p_feedback_id;
  select coalesce(nullif(left(btrim(v_feedback.subject), 100), ''), 'Support query') into v_title;
  if v_feedback.user_id is not null then
    insert into public.app_notifications(user_id, dedupe_key, category, title, body, href)
    values (v_feedback.user_id, 'support-reply:' || v_message_id::text, 'info', 'Support reply received', 'Your support query "' || v_title || '" has received a reply.', '/settings?support=' || p_feedback_id::text)
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  return jsonb_build_object('accepted', true, 'duplicate', false, 'message_id', v_message_id, 'status', 'waiting_for_user');
end $$;

create or replace function public.support_set_status(p_feedback_id uuid, p_status text, p_maintainer_id uuid, p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_updated_at timestamptz;
begin
  if p_status not in ('open','in_progress','waiting_for_user','resolved') or p_maintainer_id is null then
    raise exception 'Invalid support status.' using errcode = '22023';
  end if;
  select updated_at into v_updated_at from public.support_feedback where id = p_feedback_id for update;
  if not found then raise exception 'Support conversation not found.' using errcode = 'P0002'; end if;
  if p_expected_updated_at is null or v_updated_at is distinct from p_expected_updated_at then raise exception 'Support conversation changed. Refresh and retry.' using errcode = '40001'; end if;
  update public.support_feedback set status = p_status, updated_at = now(), last_activity_at = now()
  where id = p_feedback_id returning status into v_status;
  update public.ai_help_answer_feedback old set
    status = case when p_status = 'resolved' then 'resolved' when p_status = 'open' then 'pending' else 'reviewed' end,
    reviewed_at = case when p_status = 'open' then null else now() end,
    reviewer_id = case when p_status = 'open' then null else p_maintainer_id end
  where old.id::text = (select metadata->>'legacy_answer_feedback_id' from public.support_feedback where id = p_feedback_id);
  return jsonb_build_object('status', v_status);
end $$;

create or replace function public.review_unified_ai_answer_feedback(p_legacy_id uuid, p_status text, p_reviewer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_record public.ai_help_answer_feedback%rowtype; v_unified_id uuid;
begin
  if p_status not in ('reviewed','resolved') or p_reviewer_id is null then raise exception 'Invalid feedback status.' using errcode = '22023'; end if;
  select * into v_record from public.ai_help_answer_feedback where id = p_legacy_id for update;
  if not found then raise exception 'Feedback report not found.' using errcode = 'P0002'; end if;
  if v_record.status <> 'pending' and v_record.status <> p_status then raise exception 'Feedback report changed. Refresh and retry.' using errcode = '40001'; end if;
  update public.ai_help_answer_feedback set status = p_status, reviewed_at = coalesce(reviewed_at, now()), reviewer_id = coalesce(reviewer_id, p_reviewer_id) where id = p_legacy_id returning * into v_record;
  select id into v_unified_id from public.support_feedback where metadata->>'legacy_answer_feedback_id' = p_legacy_id::text;
  if v_unified_id is not null then
    update public.support_feedback set status = case when p_status = 'resolved' then 'resolved' else 'in_progress' end,
      maintainer_seen_at = now(), maintainer_seen_by = p_reviewer_id, updated_at = now()
      where id = v_unified_id;
  end if;
  return jsonb_build_object('id', v_record.id, 'status', v_record.status, 'reviewed_at', v_record.reviewed_at, 'reviewer_id', v_record.reviewer_id);
end $$;

create or replace function public.set_support_email_outcome(p_outbox_id uuid, p_status text, p_provider_message_id text default null, p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_feedback_id uuid;
begin
  if p_status not in ('accepted','failed','uncertain') then raise exception 'Invalid email outcome.' using errcode = '22023'; end if;
  update public.support_feedback_email_outbox set status = p_status, attempt_count = attempt_count + 1,
    provider_message_id = case when p_status = 'accepted' then p_provider_message_id else null end,
    last_error_code = left(p_error_code, 40), accepted_at = case when p_status = 'accepted' then now() else null end, updated_at = now()
  where id = p_outbox_id and status in ('pending','processing') returning feedback_id into v_feedback_id;
  if v_feedback_id is null then raise exception 'Pending email record not found.' using errcode = 'P0002'; end if;
  update public.support_feedback set email_status = p_status, updated_at = now() where id = v_feedback_id;
end $$;

create or replace function public.expire_stale_support_email_outbox()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with stale as (
    update public.support_feedback_email_outbox
      set status = 'uncertain', attempt_count = least(attempt_count + 1, 10), last_error_code = 'delivery_timeout', updated_at = now()
      where status = 'processing' and updated_at < now() - interval '2 minutes'
      returning feedback_id
  )
  update public.support_feedback set email_status = 'uncertain', updated_at = now()
  where id in (select feedback_id from stale) and email_status in ('pending','failed');
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.submit_unified_support_feedback(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.submit_unified_support_feedback(uuid,uuid,text,text,text,text) to service_role;
revoke all on function public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text) to service_role;
revoke all on function public.support_user_reply(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.support_user_reply(uuid,uuid,uuid,text) to service_role;
revoke all on function public.support_maintainer_reply(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.support_maintainer_reply(uuid,uuid,uuid,text) to service_role;
revoke all on function public.support_set_status(uuid,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.support_set_status(uuid,text,uuid,timestamptz) to service_role;
revoke all on function public.review_unified_ai_answer_feedback(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.review_unified_ai_answer_feedback(uuid,text,uuid) to service_role;
revoke all on function public.set_support_email_outcome(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.set_support_email_outcome(uuid,text,text,text) to service_role;
revoke all on function public.expire_stale_support_email_outbox() from public, anon, authenticated;
grant execute on function public.expire_stale_support_email_outbox() to service_role;

comment on table public.support_feedback is 'Authenticated user feedback and support threads. Threads, replies, and pending email jobs are deleted with the account to honor ProgressTracker account deletion behavior.';
comment on table public.support_feedback_email_outbox is 'Durable, idempotent Brevo notification outbox. Uncertain outcomes must not be automatically retried.';
commit;
