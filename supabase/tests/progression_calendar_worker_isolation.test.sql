begin;
set local timezone='UTC';
select plan(14);

-- Two ordered accounts exercise per-account error isolation; 52 following
-- accounts make the 50-account keyset page wrap and advance deterministically.
insert into auth.users(id,email)
select user_id,'worker-fixture-'||user_id::text||'@example.test'
from (
  select '00000000-0000-4000-8000-000000009201'::uuid as user_id
  union all select '00000000-0000-4000-8000-000000009202'::uuid
  union all select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(9300,9351) n
) users;

insert into public.app_settings(id,user_id,timezone,timezone_configured)
select 'general',u.id,'UTC',true from auth.users u
where u.id between '00000000-0000-4000-8000-000000009201'::uuid and '00000000-0000-4000-8000-000000009351'::uuid
on conflict(user_id) do update set timezone='UTC',timezone_configured=true;

insert into public.progression_account_state(user_id,initialized_at,scoring_version,legacy_xp_kind)
select u.id,(current_date-30)::timestamptz,2,'unavailable' from auth.users u
where u.id between '00000000-0000-4000-8000-000000009201'::uuid and '00000000-0000-4000-8000-000000009351'::uuid
on conflict(user_id) do update set initialized_at=excluded.initialized_at,scoring_version=2,legacy_xp_kind='unavailable';
update public.progression_achievement_accounts set initialized_at=(current_date-30)::timestamptz
where user_id between '00000000-0000-4000-8000-000000009201'::uuid and '00000000-0000-4000-8000-000000009351'::uuid;

set constraints all immediate;
alter table public.trackers disable trigger user;
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
values
 ('00000000-0000-4000-8000-000000009211','00000000-0000-4000-8000-000000009201',1,'habit','archived','Malformed archived tracker',
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000009211','kind','habit','status','archived','name','Malformed archived tracker',
    'createdAt',(current_date-30)::text||'T00:00:00Z','startDate',(current_date-30)::text,'archivedAt','not-a-date',
    'schedule',jsonb_build_object('kind','every-day'),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  (current_date-30)::timestamptz,(current_date-30)::timestamptz),
 ('00000000-0000-4000-8000-000000009221','00000000-0000-4000-8000-000000009202',1,'habit','active','Worker success tracker',
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000009221','kind','habit','status','active','name','Worker success tracker',
    'createdAt',(current_date-30)::text||'T00:00:00Z','startDate',(current_date-30)::text,
    'schedule',jsonb_build_object('kind','every-day'),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  (current_date-30)::timestamptz,(current_date-30)::timestamptz);
set constraints all immediate;
alter table public.trackers enable trigger user;

set constraints all immediate;
alter table public.tracker_entries disable trigger tracker_entries_progression_award;
alter table public.tracker_entries disable trigger z_progression_achievement_entry_change;
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000009231','00000000-0000-4000-8000-000000009202',
  '00000000-0000-4000-8000-000000009221',current_date,'recorded','{"done":true}'::jsonb,'worker synthetic source');
set constraints all immediate;
alter table public.tracker_entries enable trigger tracker_entries_progression_award;
alter table public.tracker_entries enable trigger z_progression_achievement_entry_change;
select public.record_progression_entry_award('00000000-0000-4000-8000-000000009202','00000000-0000-4000-8000-000000009221',
  '00000000-0000-4000-8000-000000009231',current_date,'{"done":true}'::jsonb,'recorded',null);

update public.progression_perfect_day_worker_cursor set last_user_id='00000000-0000-0000-0000-000000009200' where singleton;
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009202'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=current_date),0::bigint,'worker fixture begins without Perfect Day XP');
select is(public.reconcile_current_perfect_days(500),1,'worker processes the qualifying account in its first bounded page');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009202'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=current_date and xp_delta=20),1::bigint,
  'a malformed earlier account does not block the later owner award');
select is((select last_sqlstate from public.progression_perfect_day_worker_failures where user_id='00000000-0000-4000-8000-000000009201'),
  '22007'::text,'the failure table records only the malformed-date SQLSTATE');
select is((select last_user_id from public.progression_perfect_day_worker_cursor where singleton),
  '00000000-0000-4000-8000-000000009347'::uuid,'the first account page is capped at 50 and advances its cursor');

select is(public.reconcile_current_perfect_days(50),0,'the next page processes the remaining four accounts');
select is((select last_user_id from public.progression_perfect_day_worker_cursor where singleton),
  '00000000-0000-4000-8000-000000009351'::uuid,'the cursor reaches the last account before wrapping');
select is(public.reconcile_current_perfect_days(50),0,'the worker wraps fairly after reaching the end of the account keyspace');
select is((select last_user_id from public.progression_perfect_day_worker_cursor where singleton),
  '00000000-0000-4000-8000-000000009347'::uuid,'the wrapped page returns to the first 50 accounts');
select is((select failure_count from public.progression_perfect_day_worker_failures where user_id='00000000-0000-4000-8000-000000009201'),
  2,'the failed account is retried on a later fair pass without blocking others');

-- Repair the bad account's synthetic history and prove a later pass clears its
-- diagnostic and recovers the award through the canonical reconciler.
set constraints all immediate;
alter table public.trackers disable trigger user;
update public.trackers set status='active',definition=(definition-'archivedAt')||jsonb_build_object('status','active'),updated_at=(current_date-30)::timestamptz
where id='00000000-0000-4000-8000-000000009211';
set constraints all immediate;
alter table public.trackers enable trigger user;
set constraints all immediate;
alter table public.tracker_entries disable trigger tracker_entries_progression_award;
alter table public.tracker_entries disable trigger z_progression_achievement_entry_change;
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000009232','00000000-0000-4000-8000-000000009201',
  '00000000-0000-4000-8000-000000009211',current_date,'recorded','{"done":true}'::jsonb,'recovered synthetic source');
set constraints all immediate;
alter table public.tracker_entries enable trigger tracker_entries_progression_award;
alter table public.tracker_entries enable trigger z_progression_achievement_entry_change;
select public.record_progression_entry_award('00000000-0000-4000-8000-000000009201','00000000-0000-4000-8000-000000009211',
  '00000000-0000-4000-8000-000000009232',current_date,'{"done":true}'::jsonb,'recorded',null);
select is(public.reconcile_current_perfect_days(50),0,'the short tail page advances before the recovered account is revisited');
select is(public.reconcile_current_perfect_days(50),1,'the next wrapped pass recovers the repaired account');
select ok(not exists(select 1 from public.progression_perfect_day_worker_failures where user_id='00000000-0000-4000-8000-000000009201'),
  'a successful retry clears its private failure diagnostic');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000009201'
  and reason_code='PERFECT_DAY_BONUS' and effective_date=current_date and xp_delta=20),1::bigint,
  'recovery appends exactly one canonical Perfect Day award');

select * from finish();
rollback;
