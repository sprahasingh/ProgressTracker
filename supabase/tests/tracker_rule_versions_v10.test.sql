begin;
set local timezone = 'UTC';
select plan(23);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000191', 'tracker-rule-versions@example.test');

with versions as (
  select jsonb_build_array(
    jsonb_build_object('id','version-one','effectiveFrom','2026-10-01','revision',1,'application','baseline','recordedAt','2026-10-01T00:00:00Z',
      'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
        'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',5,'streakQualification','minimum'))),
        'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','minimum'),'streakRuleMode','same-as-success','streakRule',null,'strictMode',false)),
    jsonb_build_object('id','version-two','effectiveFrom','2026-10-10','revision',2,'application','apply-from-today','recordedAt','2026-10-10T12:00:00Z',
      'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
        'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',10,'streakQualification','minimum'))),
        'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','minimum'),'streakRuleMode','same-as-success','streakRule',null,'strictMode',false))
  ) as value
), tracker_definition as (
  select jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000291','name','Versioned tracker','kind','habit','status','active',
    'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',10,'streakQualification','minimum'))),
    'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','minimum'),'streakRuleMode','same-as-success','strictMode',false,'ruleVersions',versions.value) as value
  from versions
)
insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
select '00000000-0000-4000-8000-000000000291','00000000-0000-4000-8000-000000000191',10,'habit','active','Versioned tracker',value
from tracker_definition;

select is((select schema_version from public.trackers where id='00000000-0000-4000-8000-000000000291'),10::smallint,
  'the owner-scoped tracker row accepts a validated v10 rule history');
select is((select jsonb_array_length(definition->'ruleVersions') from public.trackers where id='00000000-0000-4000-8000-000000000291'),2,
  'rule versions remain atomic with the tracker definition');
select is((public.progression_tracker_definition_for_date((select definition from public.trackers where id='00000000-0000-4000-8000-000000000291'),'2026-10-09')->'metrics'->0->'thresholds'->>'minimum'),'5'::text,
  'a date before the boundary resolves the prior metric threshold');
select is((public.progression_tracker_definition_for_date((select definition from public.trackers where id='00000000-0000-4000-8000-000000000291'),'2026-10-10')->'metrics'->0->'thresholds'->>'minimum'),'10'::text,
  'the effective start date is inclusive');
select is(public.progression_entry_success_qualifies_on_date((select definition from public.trackers where id='00000000-0000-4000-8000-000000000291'),'{"amount":5}'::jsonb,'recorded','2026-10-09'),true,
  'historical success uses the rule version effective on the entry date');
select is(public.progression_entry_streak_qualifies_on_date((select definition from public.trackers where id='00000000-0000-4000-8000-000000000291'),'{"amount":5}'::jsonb,'recorded','2026-10-09'),true,
  'Same as Success resolves within the same historical version');
select is(public.progression_entry_success_qualifies_on_date((select definition from public.trackers where id='00000000-0000-4000-8000-000000000291'),'{"amount":5}'::jsonb,'recorded','2026-10-10'),false,
  'entries on the new version start date use the new success rule');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000292','00000000-0000-4000-8000-000000000191',10,'habit','active','Invalid history',
jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000292','kind','habit','status','active','name','Invalid history','schedule','{"kind":"every-day"}'::jsonb,
'metrics','[]'::jsonb,'ruleVersions',jsonb_build_array(jsonb_build_object('id','newer','effectiveFrom','2026-10-10','revision',1,'application','baseline','recordedAt','2026-10-10T00:00:00Z','evaluation',jsonb_build_object('schedule','{"kind":"every-day"}'::jsonb,'metrics','[]'::jsonb)),jsonb_build_object('id','older','effectiveFrom','2026-10-01','revision',2,'application','apply-from-today','recordedAt','2026-10-10T00:00:00Z','evaluation',jsonb_build_object('schedule','{"kind":"every-day"}'::jsonb,'metrics','[]'::jsonb)))))$$,
  '23514', null, 'the server rejects out-of-order effective versions');

update public.trackers
set definition = jsonb_set(jsonb_set(definition, '{metrics,0,name}', '"Renamed"'::jsonb), '{metrics,0,precision}', '{"decimalPlaces":1,"increment":0.1}'::jsonb)
where id = '00000000-0000-4000-8000-000000000291';
select is((select public.progression_tracker_evaluation_signature(definition)
    = public.progression_tracker_evaluation_signature(definition->'ruleVersions'->-1->'evaluation')
  from public.trackers where id = '00000000-0000-4000-8000-000000000291'), true,
  'cosmetic metric metadata can change without rewriting the historical rule snapshot');

select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,unit}', '"minutes"'::jsonb)
  where id = '00000000-0000-4000-8000-000000000291'$$,
  '23514', null, 'the server rejects current evaluation settings that diverge from the effective head version');

select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000293','00000000-0000-4000-8000-000000000191',10,'habit','active','Missing date',
jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000293','kind','habit','status','active','name','Missing date',
'schedule','{"kind":"every-day"}'::jsonb,'metrics','[]'::jsonb,
'ruleVersions',jsonb_build_array(jsonb_build_object('id','missing-date','revision',1,'application','baseline','recordedAt','2026-10-01T00:00:00Z',
'evaluation',jsonb_build_object('schedule','{"kind":"every-day"}'::jsonb,'metrics','[]'::jsonb)))))$$,
  '23514', null, 'the server rejects rule versions with missing effective dates');
select throws_ok($$insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000297','00000000-0000-4000-8000-000000000191',10,'habit','active','Missing history',
jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000297','kind','habit','status','active','name','Missing history',
'schedule','{"kind":"every-day"}'::jsonb,'metrics','[]'::jsonb))$$,
  '23514', null, 'schema v10 rejects a tracker that omits its rule history');

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000194', 'tracker-rule-history-day@example.test');
insert into public.app_settings (id, user_id, timezone, timezone_configured)
values ('general', '00000000-0000-4000-8000-000000000194', 'UTC', true);
insert into public.progression_achievement_accounts (user_id, initialized_at)
values ('00000000-0000-4000-8000-000000000194', ((current_date - 10)::timestamp at time zone 'UTC'))
on conflict (user_id) do update set initialized_at = excluded.initialized_at;

set local session_replication_role = replica;
with snapshots as (
  select jsonb_build_object('schedule', jsonb_build_object('kind','every-day'),
    'startDate', (current_date - 10), 'scheduling', jsonb_build_object('mode','ongoing'),
    'metrics', jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('direction','increase','minimum',1,'target',2))),
    'qualificationRule', jsonb_build_object('kind','comparison','metricId','amount','operator','at-least','value',5),
    'streakRuleMode','same-as-success','strictMode',false) as baseline,
    jsonb_build_object('schedule', jsonb_build_object('kind','every-day'),
    'startDate', (current_date - 10), 'scheduling', jsonb_build_object('mode','ongoing'),
    'metrics', jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity',
      'thresholds',jsonb_build_object('direction','increase','minimum',1,'target',2))),
    'qualificationRule', jsonb_build_object('kind','comparison','metricId','amount','operator','at-least','value',10),
    'streakRuleMode','same-as-success','strictMode',false) as current
), definition as (
  select jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000000294',
    'kind','habit','status','active','name','Boundary tracker','startDate',current_date - 10,
    'schedule',current->'schedule','scheduling',current->'scheduling','metrics',current->'metrics',
    'qualificationRule',current->'qualificationRule','streakRuleMode',current->'streakRuleMode',
    'strictMode',current->'strictMode',
    'ruleVersions',jsonb_build_array(
      jsonb_build_object('id','baseline','effectiveFrom',current_date - 10,'revision',1,'application','baseline',
        'recordedAt',clock_timestamp(),'evaluation',baseline),
      jsonb_build_object('id','prospective','effectiveFrom',current_date - 1,'revision',2,'application','apply-from-today',
        'recordedAt',clock_timestamp(),'evaluation',current)
    )) as value
  from snapshots
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at,updated_at)
select '00000000-0000-4000-8000-000000000294','00000000-0000-4000-8000-000000000194',10,'habit','active','Boundary tracker',value,
  ((current_date - 10)::timestamp at time zone 'UTC'),clock_timestamp()
from definition;
insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,created_at,updated_at,server_changed_at)
values
 ('00000000-0000-4000-8000-000000000295','00000000-0000-4000-8000-000000000194','00000000-0000-4000-8000-000000000294',current_date - 2,'recorded','{"amount":5}',clock_timestamp(),clock_timestamp(),clock_timestamp()),
 ('00000000-0000-4000-8000-000000000296','00000000-0000-4000-8000-000000000194','00000000-0000-4000-8000-000000000294',current_date - 1,'recorded','{"amount":5}',clock_timestamp(),clock_timestamp(),clock_timestamp());
set local session_replication_role = origin;

select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000000194',current_date - 2),'perfect'::text,
  'Perfect Day resolves the saved historical rule even when the v10 tracker row was updated today');
select is(public.progression_evaluate_perfect_day('00000000-0000-4000-8000-000000000194',current_date - 1),'failed'::text,
  'Perfect Day resolves a later effective rule boundary for the next historical date');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.progression_evaluate_perfect_day(uuid,date)'::regprocedure)) > 0,
  'Perfect Day keeps the conservative update boundary for legacy trackers');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.progression_evaluate_perfect_day_excluding(uuid,date,uuid)'::regprocedure)) > 0,
  'Perfect Day deletion reconciliation keeps the legacy boundary');
select ok(position('public.progression_perfect_period_day_qualifies' in pg_get_functiondef('public.progression_perfect_month_qualifies(uuid,date,uuid)'::regprocedure)) > 0,
  'new Perfect Month periods evaluate each source date through versioned account-day rules');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.progression_perfect_month_qualifies_legacy(uuid,date,uuid)'::regprocedure)) > 0,
  'preserved Perfect Month awards keep the conservative legacy boundary');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.reconcile_progression_achievements_base(uuid)'::regprocedure)) > 0,
  'aggregate achievement recalculation no longer truncates v10 history at updated_at');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.reconcile_progression_extended_achievements(uuid)'::regprocedure)) > 0,
  'repeatable achievement recalculation retains legacy safeguards and includes v10 history');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.reconcile_progression_new_badges_before_tracker_deletion()'::regprocedure)) > 0,
  'Wins deletion checks retain the legacy history boundary');
select ok(position('t.schema_version < 10' in pg_get_functiondef('public.reconcile_progression_tracker_trigger()'::regprocedure)) > 0,
  'tracker changes recalculate Perfect Days using versioned history without changing the XP cutover');
select ok(position('v_state = ''unsupported'' then return;' in pg_get_functiondef('public.reconcile_progression_perfect_day(uuid,date)'::regprocedure)) > 0,
  'unsupported Perfect Day history is preserved instead of reversing an existing award');

select * from finish();
rollback;
