begin;
select plan(40);
set local timezone = 'UTC';

select has_function('public', 'progression_perfect_month_qualifies', array['uuid', 'date', 'uuid'], 'Perfect Month uses a server-side eligibility selector');
select has_function('public', 'progression_comeback_candidates', array['uuid', 'date', 'date'], 'Comeback candidates are derived on the server');
select has_table('public', 'progression_achievement_event_sources', 'new badge source attribution is stored separately');
select is((select relrowsecurity from pg_class where oid='public.progression_achievement_event_sources'::regclass), true, 'badge source attribution has RLS enabled');
select ok(not has_table_privilege('authenticated', 'public.progression_achievement_event_sources', 'select'), 'clients cannot read private badge source attribution');
select ok(not has_function_privilege('authenticated', 'public.reconcile_progression_extended_achievements(uuid)', 'execute'), 'clients cannot invoke achievement reconciliation');

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000420','perfect-month@example.test'),
 ('00000000-0000-4000-8000-000000000422','comeback-standard@example.test'),
 ('00000000-0000-4000-8000-000000000423','comeback-strict@example.test'),
 ('00000000-0000-4000-8000-000000000424','perfect-month-holiday@example.test');
insert into public.app_settings(user_id,timezone) values
 ('00000000-0000-4000-8000-000000000420','UTC'),
 ('00000000-0000-4000-8000-000000000422','UTC'),
 ('00000000-0000-4000-8000-000000000423','UTC'),
 ('00000000-0000-4000-8000-000000000424','UTC');

create temporary table extended_badge_fixture_dates on commit drop as
select date_trunc('month', current_date::timestamp - interval '1 month')::date as month_start,
  (date_trunc('month', current_date::timestamp - interval '2 months'))::date as older_month_start;
update public.progression_policy_cutovers c
set perfect_week_start = date_trunc('week', d.older_month_start::timestamp + interval '7 days')::date,
    perfect_month_start = d.older_month_start
from extended_badge_fixture_dates d
where c.id;
update public.progression_achievement_accounts a set initialized_at = d.older_month_start - 2
from extended_badge_fixture_dates d
where a.user_id in (
 '00000000-0000-4000-8000-000000000420','00000000-0000-4000-8000-000000000422',
 '00000000-0000-4000-8000-000000000423','00000000-0000-4000-8000-000000000424'
);

alter table public.trackers disable trigger user;
alter table public.tracker_entries disable trigger user;
insert into public.trackers(id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
select x.tracker_id, x.user_id, 1, 'habit', 'active', 'Synthetic badge tracker',
  jsonb_build_object('schemaVersion',1,'id',x.tracker_id::text,'kind','habit','status','active',
    'createdAt',d.older_month_start::text||'T00:00:00Z','startDate',d.older_month_start::text,
    'schedule',jsonb_build_object('kind','every-day'),'strictMode',x.strict_mode,
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean'))),
  d.older_month_start::timestamp at time zone 'UTC', d.older_month_start::timestamp at time zone 'UTC'
from (values
 ('00000000-0000-4000-8000-000000000421'::uuid,'00000000-0000-4000-8000-000000000420'::uuid,false),
 ('00000000-0000-4000-8000-000000004221'::uuid,'00000000-0000-4000-8000-000000000422'::uuid,false),
 ('00000000-0000-4000-8000-000000004231'::uuid,'00000000-0000-4000-8000-000000000423'::uuid,true),
 ('00000000-0000-4000-8000-000000004241'::uuid,'00000000-0000-4000-8000-000000000424'::uuid,false)
) x(tracker_id,user_id,strict_mode) cross join extended_badge_fixture_dates d;

insert into public.account_holidays(id,user_id,holiday_date,reason)
select md5(user_id::text||':badge-holiday')::uuid, user_id, d.month_start + 6, 'personal'
from (values
 ('00000000-0000-4000-8000-000000000422'::uuid),
 ('00000000-0000-4000-8000-000000000423'::uuid),
 ('00000000-0000-4000-8000-000000000424'::uuid)
) users(user_id) cross join extended_badge_fixture_dates d;

insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(t.id::text||':'||d.day::date::text)::uuid, t.user_id, t.id, d.day::date, 'recorded', '{"done":true}'::jsonb,
  d.day at time zone 'UTC', d.day at time zone 'UTC'
from public.trackers t cross join extended_badge_fixture_dates f
cross join lateral generate_series(f.older_month_start::timestamp,
  (f.month_start + interval '1 month' - interval '1 day')::timestamp, interval '1 day') d(day)
where t.id in ('00000000-0000-4000-8000-000000000421','00000000-0000-4000-8000-000000004241');

-- Standard Mode misses offset 3, then qualifies on seven scheduled dates. The
-- account holiday at offset 6 pauses Standard Mode and does not count as a miss.
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(t.id::text||':'|| (f.month_start + offsets.day_offset)::text)::uuid, t.user_id, t.id,
  f.month_start + offsets.day_offset, 'recorded', '{"done":true}'::jsonb,
  (f.month_start + offsets.day_offset)::timestamp at time zone 'UTC', (f.month_start + offsets.day_offset)::timestamp at time zone 'UTC'
from public.trackers t cross join extended_badge_fixture_dates f
cross join (values (0),(1),(2),(4),(5),(7),(8),(9),(10),(11)) offsets(day_offset)
where t.id='00000000-0000-4000-8000-000000004221';

-- Strict Mode requires the holiday opportunity. The missing holiday breaks the
-- prior run; the seven following calendar opportunities complete the recovery.
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at)
select md5(t.id::text||':'|| (f.month_start + offsets.day_offset)::text)::uuid, t.user_id, t.id,
  f.month_start + offsets.day_offset, 'recorded', '{"done":true}'::jsonb,
  (f.month_start + offsets.day_offset)::timestamp at time zone 'UTC', (f.month_start + offsets.day_offset)::timestamp at time zone 'UTC'
from public.trackers t cross join extended_badge_fixture_dates f
cross join (select generate_series(0,5) as day_offset union all select generate_series(7,13)) offsets
where t.id='00000000-0000-4000-8000-000000004231';

-- Flush deferred foreign-key trigger events from the bulk fixture inserts
-- before changing trigger state again. PostgreSQL rejects ALTER TABLE while
-- deferred trigger events remain queued in the transaction.
set constraints all immediate;
alter table public.tracker_entries enable trigger user;
alter table public.trackers enable trigger user;

select is(public.progression_perfect_month_qualifies('00000000-0000-4000-8000-000000000420', (select month_start from extended_badge_fixture_dates)), true, 'a complete month with at least twelve qualifying required dates qualifies');
select is(public.progression_perfect_month_qualifies('00000000-0000-4000-8000-000000000424', (select month_start from extended_badge_fixture_dates)), true, 'a Standard Mode holiday is neutral and does not disqualify a month');
select is(public.progression_perfect_month_qualifies('00000000-0000-4000-8000-000000000424', (select older_month_start from extended_badge_fixture_dates)), true, 'a holiday in one month does not disqualify a different month');
select ok(not public.progression_perfect_month_qualifies('00000000-0000-4000-8000-000000000420', date_trunc('month', current_date::timestamp)::date), 'the still-open current month is never awarded');
select ok(public.progression_perfect_week_qualifies('00000000-0000-4000-8000-000000000420', date_trunc('week', (select older_month_start::timestamp + interval '7 days' from extended_badge_fixture_dates))::date), 'a completed Monday-based week with at least three qualifying dates qualifies');
select is((select count(*) from public.progression_comeback_candidates('00000000-0000-4000-8000-000000000422', (select month_start from extended_badge_fixture_dates), current_date - 1) where source_tracker_id='00000000-0000-4000-8000-000000004221'), 1::bigint, 'Standard Mode pauses the comeback sequence for its holiday');
select is((select missed_on from public.progression_comeback_candidates('00000000-0000-4000-8000-000000000422', (select month_start from extended_badge_fixture_dates), current_date - 1) where source_tracker_id='00000000-0000-4000-8000-000000004221'), (select month_start + 3 from extended_badge_fixture_dates), 'Standard Mode identifies the missed required opportunity');
select is((select count(*) from public.progression_comeback_candidates('00000000-0000-4000-8000-000000000423', (select month_start from extended_badge_fixture_dates), current_date - 1) where source_tracker_id='00000000-0000-4000-8000-000000004231'), 1::bigint, 'Strict Mode treats the holiday as a required opportunity and accepts recovery after it');
select is((select missed_on from public.progression_comeback_candidates('00000000-0000-4000-8000-000000000423', (select month_start from extended_badge_fixture_dates), current_date - 1) where source_tracker_id='00000000-0000-4000-8000-000000004231'), (select month_start + 6 from extended_badge_fixture_dates), 'Strict Mode identifies the uncompleted holiday as the missed opportunity');

select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000420');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000424');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000422');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000423');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-month' and event_type='unlocked'), 2::bigint, 'two qualified months create separate Perfect Month events');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-month'), 2, 'Perfect Month progress records the repeatable earned count');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000424' and achievement_id='perfect-month' and event_type='unlocked'), 2::bigint, 'neutral holidays do not prevent a qualifying month award');
select ok((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week' and event_type='unlocked') > 0, 'completed qualifying weeks create repeatable Perfect Week events');
create temporary table perfect_week_retry_count on commit drop as
select count(*)::integer as event_count from public.progression_achievement_events
where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week' and event_type='unlocked';
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week'), (select event_count from perfect_week_retry_count), 'Perfect Week current tier matches earned period count');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000422' and achievement_id='the-comeback' and event_type='unlocked'), 1::bigint, 'Standard Mode recovery creates one Comeback event');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000423' and achievement_id='the-comeback' and event_type='unlocked'), 1::bigint, 'Strict Mode recovery creates one Comeback event');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000420');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000422');
select public.reconcile_progression_achievements('00000000-0000-4000-8000-000000000423');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-month' and event_type='unlocked'), 2::bigint, 'retry does not duplicate either month award');
select is((select count(*) from public.progression_achievement_events where user_id in ('00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000000423') and achievement_id='the-comeback' and event_type='unlocked'), 2::bigint, 'retry does not duplicate either recovery award');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week'), (select count(*)::integer from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week' and event_type='unlocked' and not exists(select 1 from public.progression_achievement_events r where r.user_id=progression_achievement_events.user_id and r.reverses_event_id=progression_achievement_events.id)), 'Perfect Week retry preserves exact repeatable award progress');
select is((select count(*)::integer from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week' and event_type='unlocked'), (select event_count from perfect_week_retry_count), 'reconciliation retry does not create duplicate Perfect Week events');
select ok(not exists(select 1 from public.progression_events where user_id in ('00000000-0000-4000-8000-000000000420','00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000000423','00000000-0000-4000-8000-000000000424')), 'achievement unlocks do not award XP');
select ok(not exists(select 1 from public.progression_achievement_events e where e.user_id in ('00000000-0000-4000-8000-000000000420','00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000000423','00000000-0000-4000-8000-000000000424') and (e.source_reference::text like '%'||e.user_id::text||'%' or e.source_reference::text like '%Synthetic badge tracker%' or exists(select 1 from public.trackers t where t.user_id=e.user_id and e.source_reference::text like '%'||t.id::text||'%') or exists(select 1 from public.tracker_entries x where x.user_id=e.user_id and e.source_reference::text like '%'||x.id::text||'%'))), 'public achievement references contain no private tracker or entry identifiers');
select is((select count(*) from public.progression_achievement_event_sources s where s.user_id='00000000-0000-4000-8000-000000000420' and s.achievement_event_id in (select id from public.progression_achievement_events where user_id=s.user_id and achievement_id='perfect-month' and event_type='unlocked')), 2::bigint, 'each Perfect Month keeps private tracker attribution for safe deletion reconciliation');
create temporary table perfect_week_keep_count on commit drop as
select count(*)::integer as event_count from public.progression_achievement_events
where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-week' and event_type='unlocked'
  and not exists(select 1 from public.progression_achievement_events r where r.user_id=progression_achievement_events.user_id and r.reverses_event_id=progression_achievement_events.id);

-- Keep Wins must retain the month award while cascading its private tracker
-- attribution; Delete Wins must revoke the tracker-specific Comeback award.
update public.progression_account_state s
set initialized_at = d.month_start - 2, scoring_version = 2, legacy_xp_kind = 'unavailable'
from extended_badge_fixture_dates d
where s.user_id = '00000000-0000-4000-8000-000000000422';
alter table public.trackers disable trigger user;
update public.trackers set deleted_at=clock_timestamp()
where id='00000000-0000-4000-8000-000000000421';
update public.trackers set deleted_at=clock_timestamp()
where id='00000000-0000-4000-8000-000000004221';
alter table public.trackers enable trigger user;

select is(public.finalize_tracker_deletion('00000000-0000-4000-8000-000000000420','00000000-0000-4000-8000-000000000421','00000000-0000-4000-8000-000000004201','keep_wins')->>'status', 'deleted', 'Keep Wins permanently deletes the Perfect Month tracker');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000420' and achievement_id='perfect-month' and event_type='unlocked' and not exists(select 1 from public.progression_achievement_events r where r.user_id=progression_achievement_events.user_id and r.reverses_event_id=progression_achievement_events.id)), 2::bigint, 'Keep Wins preserves both earned Perfect Month events');
select is((select count(*) from public.progression_retained_achievement_unlocks r join public.progression_achievement_events e on e.user_id=r.user_id and e.id=r.achievement_event_id where r.user_id='00000000-0000-4000-8000-000000000420' and e.achievement_id='perfect-month'), 2::bigint, 'Keep Wins marks both Perfect Month events as retained history');
select is((select count(*) from public.progression_achievement_events u where u.user_id='00000000-0000-4000-8000-000000000420' and u.achievement_id='perfect-week' and u.event_type='unlocked' and not exists(select 1 from public.progression_achievement_events r where r.user_id=u.user_id and r.reverses_event_id=u.id)), (select event_count::bigint from perfect_week_keep_count), 'Keep Wins preserves every earned Perfect Week event');
select is((select count(*) from public.progression_retained_achievement_unlocks r join public.progression_achievement_events e on e.user_id=r.user_id and e.id=r.achievement_event_id where r.user_id='00000000-0000-4000-8000-000000000420' and e.achievement_id='perfect-week'), (select event_count::bigint from perfect_week_keep_count), 'Keep Wins retains the history state for every Perfect Week event');
select is((select count(*) from public.progression_achievement_event_sources where user_id='00000000-0000-4000-8000-000000000420' and source_tracker_id='00000000-0000-4000-8000-000000000421'), 0::bigint, 'Keep Wins removes tracker identifiers from private badge attribution');
select is(public.finalize_tracker_deletion('00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000004221','00000000-0000-4000-8000-000000004222','delete_wins')->>'status', 'deleted', 'Delete Wins permanently deletes a tracker with a Comeback award');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000422' and achievement_id='the-comeback' and event_type='unlocked'), 1::bigint, 'Delete Wins retains the original Comeback event for history');
select is((select count(*) from public.progression_achievement_events where user_id='00000000-0000-4000-8000-000000000422' and achievement_id='the-comeback' and event_type='revoked'), 1::bigint, 'Delete Wins records the Comeback revocation');
select is((select current_tier from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000422' and achievement_id='the-comeback'), 0, 'Delete Wins removes the tracker-specific Comeback from the active badge count');
select ok(not exists(select 1 from public.progression_achievement_event_sources where user_id='00000000-0000-4000-8000-000000000422' and source_tracker_id='00000000-0000-4000-8000-000000004221'), 'Delete Wins removes tracker identifiers from private badge attribution');

select * from finish();
rollback;
