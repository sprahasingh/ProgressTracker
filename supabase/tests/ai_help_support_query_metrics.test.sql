begin;
select plan(6);

select has_function('public', 'record_ai_help_metric', array['text', 'text'], 'aggregate metric writer exists for service-side outcomes');
select ok(not has_function_privilege('authenticated', 'public.record_ai_help_metric(text,text)', 'execute'), 'browser clients cannot write aggregate metrics');
select ok(has_function_privilege('service_role', 'public.record_ai_help_metric(text,text)', 'execute'), 'service role can record aggregate outcomes');

set local role service_role;
select lives_ok($$select public.record_ai_help_metric('support_query_accepted', 'goals')$$, 'accepted support query outcome is recorded');
select lives_ok($$select public.record_ai_help_metric('support_query_failed', 'goals')$$, 'failed support query outcome is recorded');
select lives_ok($$select public.record_ai_help_metric('support_query_uncertain', 'goals')$$, 'uncertain support query outcome is recorded');

reset role;
select * from finish();
rollback;
