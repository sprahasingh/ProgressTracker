begin;
select plan(18);

select has_table('public', 'ai_feature_knowledge', 'feature documentation cache exists');
select has_table('public', 'ai_question_memory', 'verified question memory exists');
select has_table('public', 'ai_knowledge_candidates', 'candidate review queue exists');
select has_column('public', 'ai_knowledge_candidates', 'candidate_fingerprint', 'candidate fingerprints do not contain user question data');
select has_table('public', 'ai_help_user_rate_limits', 'per-user rate limits exist');
select has_table('public', 'ai_help_global_rate_limit', 'global rate limits exist');
select has_table('public', 'ai_help_provider_health', 'provider health is tracked');
select has_function('public', 'consume_ai_help_request', array['uuid'], 'atomic rate-limit function exists');

select ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('ai_feature_knowledge', 'ai_question_memory', 'ai_knowledge_candidates', 'ai_help_user_rate_limits', 'ai_help_global_rate_limit', 'ai_help_provider_health')),
  'all assistant tables use row-level security');
select ok((select bool_and(not has_table_privilege('anon', format('public.%I', table_name), 'select')) from unnest(array['ai_feature_knowledge', 'ai_question_memory', 'ai_knowledge_candidates', 'ai_help_user_rate_limits', 'ai_help_global_rate_limit', 'ai_help_provider_health']) table_name),
  'anonymous users cannot read assistant tables');
select ok((select bool_and(not has_table_privilege('authenticated', format('public.%I', table_name), 'select')) from unnest(array['ai_feature_knowledge', 'ai_question_memory', 'ai_knowledge_candidates', 'ai_help_user_rate_limits', 'ai_help_global_rate_limit', 'ai_help_provider_health']) table_name),
  'authenticated users cannot read assistant tables directly');
select ok(has_function_privilege('service_role', 'public.consume_ai_help_request(uuid)', 'execute'), 'service role may consume rate-limit quota');
select ok(not has_function_privilege('authenticated', 'public.consume_ai_help_request(uuid)', 'execute'), 'authenticated clients cannot call the rate-limit function');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000991', 'ai-help-test@example.test');
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000992', 'ai-help-global-a@example.test'),
  ('00000000-0000-4000-8000-000000000993', 'ai-help-global-b@example.test');
set local role service_role;
select is((public.consume_ai_help_request('00000000-0000-4000-8000-000000000991')->>'allowed'), 'true', 'first request is allowed');
select ok((select bool_and((public.consume_ai_help_request('00000000-0000-4000-8000-000000000991')->>'allowed')::boolean) from generate_series(1, 7)), 'requests up to the per-user limit are allowed');
select is((public.consume_ai_help_request('00000000-0000-4000-8000-000000000991')->>'allowed'), 'false', 'request above the per-user limit is rejected');
select is((select count(*)::integer from public.ai_help_user_rate_limits where user_id = '00000000-0000-4000-8000-000000000991'), 1, 'per-user limit storage retains only one window row');
select is((select count(*)::integer from (select (public.consume_ai_help_request(user_id)->>'allowed')::boolean as allowed from (values ('00000000-0000-4000-8000-000000000992'::uuid), ('00000000-0000-4000-8000-000000000993'::uuid)) users(user_id) cross join generate_series(1, 8)) calls where allowed), 15, 'project-wide limiter rejects requests above its configured cap');

select * from finish();
rollback;
