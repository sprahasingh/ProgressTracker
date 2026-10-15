begin;
set local statement_timeout = '60s';
set local lock_timeout = '5s';
select plan(46);
set local timezone = 'UTC';

-- Isolated server fixtures: thresholds are measured by the same persisted
-- rows and reconciliation functions used after accepted server writes.
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000501','first-flame-below@example.test'),
 ('00000000-0000-4000-8000-000000000502','first-flame-at@example.test'),
 ('00000000-0000-4000-8000-000000000503','steady-flame-below@example.test'),
 ('00000000-0000-4000-8000-000000000504','steady-flame-at@example.test'),
 ('00000000-0000-4000-8000-000000000505','unstoppable-below@example.test'),
 ('00000000-0000-4000-8000-000000000506','unstoppable-at@example.test'),
 ('00000000-0000-4000-8000-000000000507','century-below@example.test'),
 ('00000000-0000-4000-8000-000000000508','century-at@example.test'),
 ('00000000-0000-4000-8000-000000000509','consistency-below@example.test'),
 ('00000000-0000-4000-8000-000000000510','consistency-at@example.test'),
 ('00000000-0000-4000-8000-000000000511','milestone-maker@example.test'),
 ('00000000-0000-4000-8000-000000000512','goal-crusher@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
select 'general',id,'UTC',true from auth.users
where id between '00000000-0000-4000-8000-000000000501'::uuid and '00000000-0000-4000-8000-000000000512'::uuid
on conflict (user_id) do update set timezone='UTC',timezone_configured=true;

create temporary table badge_threshold_fixtures(user_id uuid primary key, tracker_id uuid unique, entry_count integer) on commit drop;
insert into badge_threshold_fixtures values
 ('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000521',6),
 ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000522',7),
 ('00000000-0000-4000-8000-000000000503','00000000-0000-4000-8000-000000000523',13),
 ('00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000524',14),
 ('00000000-0000-4000-8000-000000000505','00000000-0000-4000-8000-000000000525',29),
 ('00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000526',30),
 ('00000000-0000-4000-8000-000000000507','00000000-0000-4000-8000-000000000527',99),
 ('00000000-0000-4000-8000-000000000508','00000000-0000-4000-8000-000000000528',100),
 ('00000000-0000-4000-8000-000000000509','00000000-0000-4000-8000-000000000529',23),
 ('00000000-0000-4000-8000-000000000510','00000000-0000-4000-8000-000000000530',24);

update public.progression_achievement_accounts set initialized_at=clock_timestamp()-interval '110 days'
where user_id in (select user_id from badge_threshold_fixtures)
   or user_id in ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000512');
update public.progression_account_state set initialized_at=clock_timestamp()-interval '110 days',scoring_version=2,legacy_xp_kind='unavailable'
where user_id in (select user_id from badge_threshold_fixtures)
   or user_id in ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000512');

alter table public.trackers disable trigger user;
alter table public.tracker_entries disable trigger user;
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
select f.tracker_id,f.user_id,1,'habit','active','Threshold fixture',
 jsonb_build_object('schemaVersion',1,'id',f.tracker_id::text,'kind','habit','status','active',
   'createdAt',(current_date-110)::text||'T00:00:00Z','startDate',(current_date-110)::text,
   'schedule',jsonb_build_object('kind','every-day'),
   'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
 (current_date-110)::timestamp at time zone 'UTC',(current_date-110)::timestamp at time zone 'UTC'
from badge_threshold_fixtures f;
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(f.tracker_id::text||':'||d.day::text)::uuid,f.user_id,f.tracker_id,d.day,'recorded','{"done":true}'::jsonb,
 d.day::timestamp at time zone 'UTC',d.day::timestamp at time zone 'UTC'
from badge_threshold_fixtures f
cross join lateral generate_series((current_date-f.entry_count+1)::timestamp,current_date::timestamp,interval '1 day') d(day)
where f.entry_count not in (23,24);
-- Consistency Star has a 30 completed eligible-day window ending yesterday.
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(f.tracker_id::text||':'||d.day::text)::uuid,f.user_id,f.tracker_id,d.day,'recorded','{"done":true}'::jsonb,
 d.day::timestamp at time zone 'UTC',d.day::timestamp at time zone 'UTC'
from badge_threshold_fixtures f
cross join lateral generate_series((current_date-30)::timestamp,(current_date-1)::timestamp,interval '1 day') d(day)
where f.entry_count in (23,24) and d.day >= current_date-f.entry_count;
set constraints all immediate;
alter table public.tracker_entries enable trigger user;
alter table public.trackers enable trigger user;

select public.reconcile_progression_achievements(user_id) from badge_threshold_fixtures;
create temporary table badge_xp_before_requalification on commit drop as
select u.user_id,coalesce(sum(e.xp_delta),0)::bigint as xp
from badge_threshold_fixtures u left join public.progression_events e on e.user_id=u.user_id group by u.user_id;
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000501' and achievement_id='first-flame')::bigint,0::bigint,'First Flame remains locked at six qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000502' and achievement_id='first-flame')::bigint,1::bigint,'First Flame persists at seven qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000503' and achievement_id='steady-flame')::bigint,0::bigint,'Steady Flame remains locked at thirteen qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000504' and achievement_id='steady-flame')::bigint,1::bigint,'Steady Flame persists at fourteen qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000505' and achievement_id='unstoppable')::bigint,0::bigint,'Unstoppable remains locked at twenty-nine qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000506' and achievement_id='unstoppable')::bigint,1::bigint,'Unstoppable persists at thirty qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000507' and achievement_id='century')::bigint,0::bigint,'Century remains locked at ninety-nine qualifying days');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000508' and achievement_id='century')::bigint,1::bigint,'Century persists at one hundred qualifying days');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000502' and achievement_id='first-flame' and event_type='unlocked'),1::bigint,'First Flame has a persisted unlock event at threshold');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000504' and achievement_id='steady-flame' and event_type='unlocked'),1::bigint,'Steady Flame has a persisted unlock event at threshold');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000506' and achievement_id='unstoppable' and event_type='unlocked'),1::bigint,'Unstoppable has a persisted unlock event at threshold');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000508' and achievement_id='century' and event_type='unlocked'),1::bigint,'Century has a persisted unlock event at threshold');
select is((select (qualification_details->>'eligible_days')::integer from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000509' and achievement_id='consistency-star'),30,'Consistency Star evaluates all thirty eligible dates below adherence threshold');
select is((select (qualification_details->>'adherence_percent')::numeric from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000509' and achievement_id='consistency-star'),76.7::numeric,'Consistency Star reports 23 of 30 as 76.7 percent');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000509' and achievement_id='consistency-star')::bigint,0::bigint,'Consistency Star stays locked below 80 percent');
select is((select (qualification_details->>'eligible_days')::integer from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000510' and achievement_id='consistency-star'),30,'Consistency Star evaluates all thirty eligible dates at threshold');
select is((select (qualification_details->>'adherence_percent')::numeric from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000510' and achievement_id='consistency-star'),80::numeric,'Consistency Star reports exactly 80 percent at 24 of 30');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000510' and achievement_id='consistency-star')::bigint,1::bigint,'Consistency Star persists its unlock at 30 days and 80 percent');

-- One-time awards revoke and requalify as new event generations while keeping
-- one active unlock. Achievement unlocks themselves do not grant XP.
alter table public.tracker_entries disable trigger user;
delete from public.tracker_entries where user_id='00000000-0000-4000-8000-000000000502' and entry_date=current_date-6;
delete from public.tracker_entries where user_id='00000000-0000-4000-8000-000000000510' and entry_date=current_date-24;
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000502');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000510');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000502' and achievement_id='first-flame' and event_type='revoked'),1::bigint,'First Flame correction records a linked revocation');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000510' and achievement_id='consistency-star' and event_type='revoked'),1::bigint,'Consistency Star correction records a linked revocation');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(tracker_id::text||':'||(current_date-6)::text)::uuid,user_id,tracker_id,current_date-6,'recorded','{"done":true}'::jsonb,clock_timestamp(),clock_timestamp()
from badge_threshold_fixtures where user_id='00000000-0000-4000-8000-000000000502';
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(tracker_id::text||':'||(current_date-24)::text)::uuid,user_id,tracker_id,current_date-24,'recorded','{"done":true}'::jsonb,clock_timestamp(),clock_timestamp()
from badge_threshold_fixtures where user_id='00000000-0000-4000-8000-000000000510';
alter table public.tracker_entries enable trigger user;
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000502');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000510');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000502' and achievement_id='first-flame' and event_type='unlocked'),2::bigint,'First Flame requalification appends a second generation');
select is((select count(*) from public.progression_achievement_events u where u.user_id='00000000-0000-4000-8000-000000000502' and u.achievement_id='first-flame' and u.event_type='unlocked' and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),1::bigint,'First Flame has only one active unlock after requalification');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000510' and achievement_id='consistency-star' and event_type='unlocked'),2::bigint,'Consistency Star requalification appends a second generation');
select ok(not exists(select 1 from badge_xp_before_requalification b where b.xp <> coalesce((select sum(e.xp_delta) from public.progression_events e where e.user_id=b.user_id),0)),'streak and consistency unlock, revocation, and requalification do not change XP');

alter table public.tracker_entries disable trigger user;
delete from public.tracker_entries where user_id='00000000-0000-4000-8000-000000000504' and entry_date=current_date-13;
delete from public.tracker_entries where user_id='00000000-0000-4000-8000-000000000506' and entry_date=current_date-29;
delete from public.tracker_entries where user_id='00000000-0000-4000-8000-000000000508' and entry_date=current_date-99;
select public.reconcile_progression_achievements(user_id) from badge_threshold_fixtures where user_id in (
 '00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000508');
select is((select count(*) from public.progression_achievement_events where user_id in ('00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000508') and event_type='revoked'),3::bigint,'Steady Flame, Unstoppable, and Century each persist a threshold revocation');
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(f.tracker_id::text||':'||(current_date-f.entry_count+1)::text)::uuid,f.user_id,f.tracker_id,current_date-f.entry_count+1,
 'recorded','{"done":true}'::jsonb,clock_timestamp(),clock_timestamp()
from badge_threshold_fixtures f where f.user_id in (
 '00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000508');
alter table public.tracker_entries enable trigger user;
select public.reconcile_progression_achievements(user_id) from badge_threshold_fixtures where user_id in (
 '00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000508');
select is((select count(*) from public.progression_achievement_events where ((user_id='00000000-0000-4000-8000-000000000504' and achievement_id='steady-flame') or (user_id='00000000-0000-4000-8000-000000000506' and achievement_id='unstoppable') or (user_id='00000000-0000-4000-8000-000000000508' and achievement_id='century')) and event_type='unlocked'),6::bigint,'each one-time streak badge appends one unlock on requalification');
select is((select count(*) from public.progression_achievement_events u where ((u.user_id='00000000-0000-4000-8000-000000000504' and u.achievement_id='steady-flame') or (u.user_id='00000000-0000-4000-8000-000000000506' and u.achievement_id='unstoppable') or (u.user_id='00000000-0000-4000-8000-000000000508' and u.achievement_id='century')) and u.event_type='unlocked' and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),3::bigint,'each one-time streak achievement retains exactly one active unlock');
select is((select count(*) from public.progression_achievement_progress where achievement_id in ('first-flame','steady-flame','unstoppable','century','consistency-star') and user_id in ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000504','00000000-0000-4000-8000-000000000506','00000000-0000-4000-8000-000000000508','00000000-0000-4000-8000-000000000510') and not repeatable),25::bigint,'all five requested one-time achievements remain non-repeatable after requalification');

-- Repeatable activity awards follow distinct source identities, reverse with
-- their source, and reactivation does not duplicate an active occurrence.
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000511');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000512');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000511' and achievement_id='milestone-maker')::bigint,0::bigint,'Milestone Maker is locked before any confirmed milestone');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000512' and achievement_id='goal-crusher')::bigint,0::bigint,'Goal Crusher is locked before any confirmed goal completion');
select is((select count(*) from public.progression_achievement_events where user_id in ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000512') and achievement_id in ('milestone-maker','goal-crusher') and event_type='unlocked'),0::bigint,'both repeatable badges have no award event below their first occurrence threshold');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000531','GOAL_MILESTONE',current_date,25,null,'00000000-0000-4000-8000-000000000541',null,true,'fixture milestone');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000512','00000000-0000-4000-8000-000000000532','GOAL_COMPLETED',current_date,100,null,'00000000-0000-4000-8000-000000000542',null,true,'fixture goal completion');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000511');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000512');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000511' and achievement_id='milestone-maker' and event_type='unlocked'),1::bigint,'Milestone Maker unlock is persisted from one confirmed milestone');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000512' and achievement_id='goal-crusher' and event_type='unlocked'),1::bigint,'Goal Crusher unlock is persisted from one confirmed completion');
select is((select xp_delta from public.progression_events where user_id='00000000-0000-4000-8000-000000000511' and reason_code='GOAL_MILESTONE'),25,'Milestone Maker source reward grants 25 XP');
select is((select xp_delta from public.progression_events where user_id='00000000-0000-4000-8000-000000000512' and reason_code='GOAL_COMPLETED'),100,'Goal Crusher source reward grants 100 XP');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000511');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000512');
select is((select count(*) from public.progression_achievement_events where user_id in ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000512') and event_type='unlocked'),2::bigint,'repeat reconciliation does not duplicate active occurrence awards');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000531','GOAL_MILESTONE',current_date,25,null,'00000000-0000-4000-8000-000000000541',null,false,'corrected milestone');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000512','00000000-0000-4000-8000-000000000532','GOAL_COMPLETED',current_date,100,null,'00000000-0000-4000-8000-000000000542',null,false,'corrected completion');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000511');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000512');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000511' and achievement_id='milestone-maker' and event_type='revoked'),1::bigint,'Milestone Maker source correction appends a revocation');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000512' and achievement_id='goal-crusher' and event_type='revoked'),1::bigint,'Goal Crusher source correction appends a revocation');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000511'),0::bigint,'milestone correction reverses the 25 XP source reward');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000512'),0::bigint,'goal correction reverses the 100 XP source reward');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000531','GOAL_MILESTONE',current_date,25,null,'00000000-0000-4000-8000-000000000541',null,true,'requalified milestone');
select public.reconcile_progression_award('00000000-0000-4000-8000-000000000512','00000000-0000-4000-8000-000000000532','GOAL_COMPLETED',current_date,100,null,'00000000-0000-4000-8000-000000000542',null,true,'requalified completion');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000511');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000512');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000511' and achievement_id='milestone-maker' and event_type='unlocked'),2::bigint,'Milestone Maker requalification appends history');
select is((select count(*) from public.progression_achievement_occurrences o join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id where o.user_id='00000000-0000-4000-8000-000000000511' and o.achievement_id='milestone-maker' and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),1::bigint,'Milestone Maker retains one active occurrence for the same source identity');
select is((select count(*) from public.progression_achievement_occurrences o join public.progression_achievement_events u on u.user_id=o.user_id and u.id=o.achievement_event_id where o.user_id='00000000-0000-4000-8000-000000000512' and o.achievement_id='goal-crusher' and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)),1::bigint,'Goal Crusher retains one active occurrence for the same source identity');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000511'),25::bigint,'milestone requalification restores 25 net XP without duplicating credit');
select is((select sum(xp_delta) from public.progression_events where user_id='00000000-0000-4000-8000-000000000512'),100::bigint,'goal requalification restores 100 net XP without duplicating credit');
select ok(not exists(select 1 from public.progression_events e where e.user_id in ('00000000-0000-4000-8000-000000000511','00000000-0000-4000-8000-000000000512') and e.reason_code not in ('GOAL_MILESTONE','GOAL_COMPLETED','AWARD_REVERSAL')),'repeatable achievement events do not award separate XP');

select * from finish();
rollback;
