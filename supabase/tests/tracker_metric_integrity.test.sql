begin;
select plan(14);

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000091', 'metric-integrity@example.test');
insert into public.trackers (id, user_id, kind, status, name, definition) values
('00000000-0000-4000-8000-000000000191', '00000000-0000-4000-8000-000000000091', 'goal', 'active', 'Integrity tracker',
 '{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000191","kind":"goal","status":"active","startDate":"2026-10-10","metrics":[{"id":"measure-a","name":"Pages","valueType":"quantity","unit":"pages"},{"id":"measure-b","name":"Sessions","valueType":"quantity","unit":"sessions"},{"id":"measure-c","name":"Minutes","valueType":"quantity","unit":"minutes"}],"schedule":{"kind":"every-day"}}');
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values) values
('00000000-0000-4000-8000-000000000291', '00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000191', '2026-10-10', 'recorded', '{"measure-a":12}');

select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,valueType}', '"boolean"') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'Saved measure types cannot be changed. Add a new measure to record values differently.', 'saved measure type is immutable');
select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics}', '[{"id":"measure-b","name":"Sessions","valueType":"quantity","unit":"sessions"}]') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'Measure measure-a has saved check-ins and cannot be removed. Retire it to preserve its history.', 'measure with history cannot be deleted');
select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,name}', '"Reading"') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'A measure with saved check-ins must keep its original name, unit, and meaning. Retire it and add a new measure instead.', 'historical measure meaning is immutable');

select lives_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,retiredAt}', '"2026-10-11T00:00:00Z"') where id = '00000000-0000-4000-8000-000000000191'$$,
  'measure with history can be retired');
select is((select entry_values->>'measure-a' from public.tracker_entries where id = '00000000-0000-4000-8000-000000000291'), '12', 'retirement preserves the historical value');
select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,retiredAt}', 'null') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'Retired measures cannot be reactivated because their historical context must remain stable.', 'retired measure cannot be reactivated');
select lives_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,0,precision}', '{"decimalPlaces":1,"increment":0.1}') where id = '00000000-0000-4000-8000-000000000191'$$,
  'precision may change without rewriting historical meaning');

select is(public.tracker_definition_references_measure(
  '{"qualificationRule":{"kind":"comparison","metricId":"measure-b"}}'::jsonb, 'measure-b'), true,
  'measure references in nested success and streak rules are detected');
select is(public.tracker_definition_references_measure(
  '{"milestones":[{"id":"milestone-b","metricId":"measure-b"}]}'::jsonb, 'measure-b'), true,
  'measure references in milestones are detected');
select is(public.tracker_definition_references_measure(
  '{"goalPlanning":{"dailyTargets":{"measure-b":1}}}'::jsonb, 'measure-b'), true,
  'measure references in goal planning maps are detected');
select lives_ok($$update public.trackers set definition = definition ||
  '{"qualificationRule":{"kind":"comparison","metricId":"measure-b","operator":"at-least","value":1},"goalPlanning":{"dailyTargets":{"measure-b":1}},"milestones":[{"id":"milestone-b","metricId":"measure-b","targetValue":1}]}'::jsonb
  where id = '00000000-0000-4000-8000-000000000191'$$,
  'tracker accepts active measure references');
select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics,1,retiredAt}', '"2026-10-12T00:00:00Z"') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'Measure measure-b is used by a rule, goal plan, or milestone. Resolve those references before retiring or removing it.',
  'measure cannot be retired while rules, goals, or milestones depend on it');
select lives_ok($$update public.trackers set definition = jsonb_set(
  definition - 'qualificationRule' - 'goalPlanning' - 'milestones', '{metrics,1,retiredAt}', '"2026-10-12T00:00:00Z"')
  where id = '00000000-0000-4000-8000-000000000191'$$,
  'measure can be retired after its dependencies are resolved');
select throws_ok($$update public.trackers set definition = jsonb_set(definition, '{metrics}', '[]') where id = '00000000-0000-4000-8000-000000000191'$$,
  '23514', 'Keep at least one active measure so this tracker can record future check-ins.', 'tracker must retain an active measure');

select * from finish();
rollback;
