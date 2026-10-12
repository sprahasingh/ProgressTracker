begin;

-- Answer ratings remain in their purpose-built, privacy-limited table. They are
-- no longer copied into the general support inbox as synthetic support cases.
create or replace function public.submit_unified_ai_answer_feedback(
  p_user_id uuid, p_response_id uuid, p_category text, p_explanation text,
  p_topic text, p_knowledge_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_feedback_id uuid;
begin
  v_result := public.submit_ai_help_answer_feedback(p_user_id, p_response_id, p_category, p_explanation, p_topic, p_knowledge_version);
  v_feedback_id := (v_result->>'feedback_id')::uuid;

  -- Helpful ratings are complete feedback events. Negative reports stay
  -- pending for maintainer review in Answer Feedback.
  if p_category = 'helpful' and v_feedback_id is not null then
    update public.ai_help_answer_feedback
      set status = 'resolved', reviewed_at = coalesce(reviewed_at, now()), reviewer_id = null
      where id = v_feedback_id and status = 'pending';
  end if;

  return v_result || jsonb_build_object('unified_feedback_id', null);
end $$;

revoke all on function public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text) to service_role;

-- Historical helpful ratings should follow the same resolved status while
-- their original records and any old support mirrors remain intact.
update public.ai_help_answer_feedback
  set status = 'resolved', reviewed_at = coalesce(reviewed_at, created_at), reviewer_id = null
  where category = 'helpful' and status = 'pending';

comment on function public.submit_unified_ai_answer_feedback(uuid,uuid,text,text,text,text)
  is 'Stores AI answer ratings only in ai_help_answer_feedback. Helpful ratings are resolved automatically; negative reports remain reviewable.';
commit;
