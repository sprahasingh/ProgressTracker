begin;
select plan(20);

select has_table('public', 'notification_subscription_rate_limits', 'subscription rate limit table exists');
select is((select relrowsecurity from pg_class where oid='public.notification_subscription_rate_limits'::regclass), true, 'rate limit table has RLS enabled');
select is((select count(*) from pg_policies where schemaname='public' and tablename='notification_subscription_rate_limits'), 0::bigint, 'rate limit table has no client policies');
select ok(not has_table_privilege('anon','public.notification_subscription_rate_limits','select')
  and not has_table_privilege('authenticated','public.notification_subscription_rate_limits','select'), 'API clients cannot inspect rate limits');
select is((select prosecdef and proconfig @> array['search_path=""']::text[]
  from pg_proc where oid='public.manage_notification_device(uuid,text,text,text,text,text,timestamptz)'::regprocedure), true,
  'subscription management RPC is SECURITY DEFINER with an empty search path');
select ok(has_function_privilege('service_role','public.manage_notification_device(uuid,text,text,text,text,text,timestamptz)','execute')
  and not has_function_privilege('anon','public.manage_notification_device(uuid,text,text,text,text,text,timestamptz)','execute')
  and not has_function_privilege('authenticated','public.manage_notification_device(uuid,text,text,text,text,text,timestamptz)','execute'),
  'only trusted server role can call subscription management');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000001701','push-owner-one@example.test'),
  ('00000000-0000-4000-8000-000000001702','push-owner-two@example.test');

set local role service_role;
select is(public.manage_notification_device('00000000-0000-4000-8000-000000001701','register','https://push.example.test/one','public-key-one','auth-secret-one','test device',null)->>'status',
  'registered', 'trusted server can register a subscription');
select is(public.manage_notification_device('00000000-0000-4000-8000-000000001701','register','https://push.example.test/one','public-key-rotated','auth-secret-rotated','test device',null)->>'status',
  'registered', 'repeated registration rotates keys idempotently');
select is((select count(*) from public.notification_devices where user_id='00000000-0000-4000-8000-000000001701'),1::bigint,
  'idempotent registration does not duplicate the device');
select is((select p256dh from public.notification_devices where endpoint='https://push.example.test/one'), 'public-key-rotated'::text,
  'registration refreshes rotated subscription keys');
select throws_ok($$select public.manage_notification_device('00000000-0000-4000-8000-000000001702','register','https://push.example.test/one','other-key','other-secret',null,null)$$,
  '23505', null, 'endpoint already assigned to another account cannot be claimed');
select is(public.manage_notification_device('00000000-0000-4000-8000-000000001702','revoke','https://push.example.test/one')->>'status',
  'revoked', 'revocation response does not disclose another account subscription');
select ok((select enabled and revoked_at is null from public.notification_devices where endpoint='https://push.example.test/one'),
  'another account cannot revoke the subscription');
select throws_ok($$select public.manage_notification_device('00000000-0000-4000-8000-000000001701','register','https://push.example.test/expired','public-key','auth-secret',null,now()-interval '1 second')$$,
  '22023', null, 'expired subscriptions cannot be registered');
select is(public.manage_notification_device('00000000-0000-4000-8000-000000001701','revoke','https://push.example.test/one')->>'status',
  'revoked', 'owner can revoke a subscription');
select ok((select not enabled and revoked_at is not null from public.notification_devices where endpoint='https://push.example.test/one'),
  'revocation disables the row and records the revocation time');
select is((select count(*) from public.notification_subscription_rate_limits where user_id='00000000-0000-4000-8000-000000001701'),1::bigint,
  'server requests are counted per account');
do $$
begin
  for request_number in 1..7 loop
    perform public.manage_notification_device('00000000-0000-4000-8000-000000001701','revoke','https://push.example.test/not-registered');
  end loop;
end;
$$;
select throws_ok($$select public.manage_notification_device('00000000-0000-4000-8000-000000001701','revoke','https://push.example.test/not-registered')$$,
  'P0001', 'subscription management rate limit exceeded', 'account rate limit blocks the eleventh request in one minute');
reset role;

delete from auth.users where id='00000000-0000-4000-8000-000000001701';
select is((select count(*) from public.notification_devices where user_id='00000000-0000-4000-8000-000000001701'),0::bigint,
  'account deletion cascades registered devices');
select is((select count(*) from public.notification_subscription_rate_limits where user_id='00000000-0000-4000-8000-000000001701'),0::bigint,
  'account deletion cascades private rate limits');

select * from finish();
rollback;
