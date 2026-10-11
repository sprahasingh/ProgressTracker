begin;
select plan(16);

select has_table('public', 'account_deletion_authorizations', 'one-use deletion authorization table exists');
select has_table('public', 'account_deletion_password_attempts', 'password verification throttle table exists');
select is((select relrowsecurity from pg_class where oid='public.account_deletion_authorizations'::regclass), true, 'authorization table has RLS enabled');
select is((select relrowsecurity from pg_class where oid='public.account_deletion_password_attempts'::regclass), true, 'password attempt table has RLS enabled');
select is((select count(*) from pg_policies where schemaname='public' and tablename in ('account_deletion_authorizations','account_deletion_password_attempts')), 0::bigint, 'private tables have no client policies');
select ok(not has_table_privilege('anon','public.account_deletion_authorizations','select')
  and not has_table_privilege('authenticated','public.account_deletion_authorizations','select')
  and not has_table_privilege('anon','public.account_deletion_password_attempts','select')
  and not has_table_privilege('authenticated','public.account_deletion_password_attempts','select'), 'API clients cannot inspect authorization or attempt state');
select ok((select prosecdef and proconfig @> array['search_path=""']::text[] from pg_proc
  where oid='public.reserve_account_deletion_password_attempt(uuid)'::regprocedure), 'rate limit RPC is SECURITY DEFINER with an empty search path');
select ok(has_function_privilege('service_role','public.reserve_account_deletion_password_attempt(uuid)','execute')
  and has_function_privilege('service_role','public.issue_account_deletion_authorization(uuid,text)','execute')
  and has_function_privilege('service_role','public.consume_account_deletion_authorization(uuid,text)','execute')
  and not has_function_privilege('anon','public.issue_account_deletion_authorization(uuid,text)','execute')
  and not has_function_privilege('authenticated','public.consume_account_deletion_authorization(uuid,text)','execute'), 'only trusted server role can manage deletion authorization');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000002701','delete-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000002702','delete-owner-two@example.test');

set local role service_role;
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), true, 'first password attempt is allowed');
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), true, 'attempts below the threshold are allowed');
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), true, 'third password attempt is allowed');
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), true, 'fourth password attempt is allowed');
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), true, 'fifth password attempt is allowed');
select is(public.reserve_account_deletion_password_attempt('00000000-0000-4000-8000-000000002701'), false, 'sixth password attempt is rate limited');
select public.issue_account_deletion_authorization('00000000-0000-4000-8000-000000002701', repeat('a', 64));
select is(public.consume_account_deletion_authorization('00000000-0000-4000-8000-000000002701', repeat('a', 64)), true, 'authorized account consumes the token once');
select is(public.consume_account_deletion_authorization('00000000-0000-4000-8000-000000002701', repeat('a', 64)), false, 'consumed token cannot be replayed');
reset role;

select * from finish();
rollback;
