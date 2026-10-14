begin;
select plan(15);

select has_table('public', 'progression_events', 'progression event ledger exists');
select has_table('public', 'progression_event_sources', 'erasable source associations exist');
select is((select relrowsecurity from pg_class where oid = 'public.progression_events'::regclass), true, 'event ledger has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.progression_event_sources'::regclass), true, 'source associations have RLS enabled');
select ok(has_table_privilege('authenticated', 'public.progression_events', 'select'), 'authenticated users can read their RLS-scoped events');
select ok(not has_table_privilege('authenticated', 'public.progression_events', 'insert'), 'clients cannot insert authoritative score events');
select ok(not has_table_privilege('authenticated', 'public.progression_events', 'update'), 'clients cannot edit score history');
select ok(not has_table_privilege('authenticated', 'public.progression_events', 'delete'), 'clients cannot delete score history');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000071', 'progression-ledger-one@example.test'),
  ('00000000-0000-4000-8000-000000000072', 'progression-ledger-two@example.test');
insert into public.progression_events(user_id,event_category,reason_code,effective_date,xp_delta,scoring_version,idempotency_key)
values ('00000000-0000-4000-8000-000000000071','legacy_opening_balance','LEGACY_XP_OPENING_BALANCE',current_date,10,1,'00000000-0000-4000-8000-000000000701');
insert into public.progression_event_sources(user_id, event_id, tracker_id, source_id, display_name)
select '00000000-0000-4000-8000-000000000071', id, '00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000712', 'Read'
from public.progression_events where idempotency_key = '00000000-0000-4000-8000-000000000701';
insert into public.trackers (id, user_id, kind, status, name, definition) values
  ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000071', 'habit', 'active', 'Read',
   '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000711","kind":"habit","status":"active","metrics":[],"schedule":{"kind":"every-day"}}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
select is((select count(*) from public.progression_events), 1::bigint, 'owner can read own score events');
select is((select count(*) from public.progression_event_sources), 1::bigint, 'owner can read own source associations');
select throws_ok($$insert into public.progression_events(user_id, event_category, reason_code, effective_date, xp_delta, scoring_version, idempotency_key) values ('00000000-0000-4000-8000-000000000071', 'check_in', 'DAILY_CHECK_IN_COMPLETED', '2026-10-12', 10, 1, '00000000-0000-4000-8000-000000000702')$$,
  '42501', null, 'authenticated user cannot forge XP');
reset role;

select throws_ok($$delete from public.trackers where id = '00000000-0000-4000-8000-000000000711'$$,
  '55000', 'permanent tracker deletion requires an explicit safe Wins retention choice', 'direct tracker deletion fails closed when account XP cannot be attributed safely');
select is((select count(*) from public.trackers where id = '00000000-0000-4000-8000-000000000711'), 1::bigint, 'blocked deletion retains tracker data');
select is((select count(*) from public.progression_event_sources), 1::bigint, 'blocked deletion preserves progression source associations with the retained tracker');
select is((select sum(xp_delta) from public.progression_events where user_id = '00000000-0000-4000-8000-000000000071'), 10::bigint, 'blocked deletion preserves earned XP');

select * from finish();
rollback;
