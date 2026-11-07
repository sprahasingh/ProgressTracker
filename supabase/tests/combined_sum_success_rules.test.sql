begin;
select plan(36);

select is(
  public.progress_tracker_capabilities(),
  '{"version":1,"capabilities":{"combinedSum":true}}'::jsonb,
  'capability marker is versioned and is committed with server support'
);

select ok(
  not p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""'],
  'capability RPC is stable, invoker-security, and uses an empty search path'
) from pg_proc p where p.oid = 'public.progress_tracker_capabilities()'::regprocedure;

select ok(has_function_privilege('authenticated', 'public.progress_tracker_capabilities()', 'EXECUTE'), 'authenticated users can read capabilities');
select ok(not has_function_privilege('anon', 'public.progress_tracker_capabilities()', 'EXECUTE') and not has_function_privilege('service_role', 'public.progress_tracker_capabilities()', 'EXECUTE'), 'anonymous and service roles cannot execute the client capability RPC');
select ok((
  select count(*) = 4
  from pg_catalog.unnest(array[
    pg_catalog.to_regprocedure('public.tracker_rule_is_valid(jsonb,jsonb)'),
    pg_catalog.to_regprocedure('public.progression_rule_qualifies(jsonb,jsonb,jsonb)'),
    pg_catalog.to_regprocedure('public.progression_tracker_evaluation_signature(jsonb)'),
    pg_catalog.to_regprocedure('public.tracker_edit_rule_metric_ids(jsonb)')
  ]) as required(oid)
  where oid is not null and pg_catalog.strpos(pg_catalog.pg_get_functiondef(oid), 'combined-sum') > 0
), 'all required Combined Sum validators and evaluators are installed');

select ok(public.tracker_rule_is_valid(
  '{"metrics":[{"id":"lc","valueType":"quantity","unit":"problems"},{"id":"cf","valueType":"quantity","unit":"problems"},{"id":"cc","valueType":"quantity","unit":"problems"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'accepts multiple compatible active quantity measures');

select ok(public.progression_rule_qualifies(
  '{"metrics":[{"id":"lc","valueType":"quantity","unit":"problems"},{"id":"cf","valueType":"quantity","unit":"problems"},{"id":"cc","valueType":"quantity","unit":"problems"}]}'::jsonb,
  '{"lc":2,"cf":2,"cc":1}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'qualifies exactly at the combined target');

select ok(public.progression_rule_qualifies(
  '{"metrics":[{"id":"lc","valueType":"quantity","unit":"problems"},{"id":"cf","valueType":"quantity","unit":"problems"},{"id":"cc","valueType":"quantity","unit":"problems"}]}'::jsonb,
  '{"lc":4,"cf":3,"cc":1}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'qualifies when the sum exceeds the target');

select ok(not public.progression_rule_qualifies(
  '{}'::jsonb, '{"lc":2,"cf":2,"cc":0}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'fails below the combined target regardless of individual thresholds');

select ok(not public.progression_rule_qualifies(
  '{}'::jsonb, '{"lc":2,"cf":2}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'treats an omitted selected value as zero');

select ok(not public.progression_rule_qualifies(
  '{}'::jsonb, '{"lc":0,"cf":0,"cc":0}'::jsonb,
  '{"kind":"combined-sum","metricIds":["lc","cf","cc"],"target":5}'::jsonb
), 'zero values do not meet a positive combined target');

select ok(public.tracker_rule_is_valid(
  '{"metrics":[{"id":"reading","valueType":"quantity","unit":"minutes"},{"id":"studying","valueType":"duration","unit":"minutes"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["reading","studying"],"target":30}'::jsonb
), 'allows Quantity and Duration measures that use the same unit');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"minutes","valueType":"duration","unit":"minutes"},{"id":"distance","valueType":"quantity","unit":"km"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["minutes","distance"],"target":5}'::jsonb
), 'rejects incompatible units');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"pages","valueType":"quantity","unit":"pages","retiredAt":"2026-01-01T00:00:00Z"},{"id":"problems","valueType":"quantity","unit":"pages"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["pages","problems"],"target":5}'::jsonb
), 'rejects retired measures');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"done","valueType":"boolean","unit":"items"},{"id":"count","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["done","count"],"target":5}'::jsonb
), 'rejects non-quantity measures');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","a"],"target":5}'::jsonb
), 'rejects fewer than two distinct measures');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":0}'::jsonb
), 'requires a positive target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"]}'::jsonb
), 'rejects a missing combined target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":null}'::jsonb
), 'rejects an explicit JSON null target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":"5"}'::jsonb
), 'rejects a string target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":true}'::jsonb
), 'rejects a boolean target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":{"value":5}}'::jsonb
), 'rejects an object target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":[5]}'::jsonb
), 'rejects an array target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":-0.5}'::jsonb
), 'rejects a negative target');

select ok(public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":0.25}'::jsonb
), 'accepts a positive fractional target');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","missing"],"target":5}'::jsonb
), 'rejects a missing measure reference');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","target":5}'::jsonb
), 'rejects missing measure IDs without raising an array error');

select ok(not public.tracker_rule_is_valid(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"kind":"combined-sum","metricIds":null,"target":5}'::jsonb
), 'rejects null measure IDs without raising an array error');

select is(public.progression_rule_qualifies(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"a":3,"b":3}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"]}'::jsonb
), false, 'missing targets fail evaluation explicitly rather than returning NULL');

select is(public.progression_rule_qualifies(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"a":3,"b":3}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","b"],"target":"5"}'::jsonb
), false, 'nonnumeric targets fail evaluation explicitly');

select is(public.progression_rule_qualifies(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"a":3,"b":3}'::jsonb,
  '{"kind":"combined-sum","metricIds":["a","missing"],"target":5}'::jsonb
), false, 'malformed measure references fail evaluation explicitly');

select is(
  (select array_agg(metric_id order by metric_id) from public.tracker_edit_rule_metric_ids('{"kind":"all","operands":[{"kind":"combined-sum","metricIds":["lc","cf"]},{"kind":"comparison","metricId":"other"}]}'::jsonb)),
  array['cf','lc','other']::text[], 'sync guards expose every combined measure dependency');

select isnt(
  public.progression_tracker_evaluation_signature('{"metrics":[{"id":"a","valueType":"quantity","unit":"problems"},{"id":"b","valueType":"quantity","unit":"problems"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5}}'::jsonb),
  public.progression_tracker_evaluation_signature('{"metrics":[{"id":"a","valueType":"quantity","unit":"minutes"},{"id":"b","valueType":"quantity","unit":"problems"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5}}'::jsonb),
  'historical evaluation signatures include selected measure unit meaning');

select ok(public.progression_entry_success_qualifies_on_date(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":99},"ruleVersions":[{"effectiveFrom":"2026-01-01","evaluation":{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5}}},{"effectiveFrom":"2026-02-01","evaluation":{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":6}}}]}'::jsonb,
  '{"a":2,"b":3}'::jsonb, 'recorded', '2026-01-15'::date
) and not public.progression_entry_success_qualifies_on_date(
  '{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":99},"ruleVersions":[{"effectiveFrom":"2026-01-01","evaluation":{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5}}},{"effectiveFrom":"2026-02-01","evaluation":{"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":6}}}]}'::jsonb,
  '{"a":2,"b":3}'::jsonb, 'recorded', '2026-02-15'::date
), 'daily success uses date-effective Combined Sum targets');

select ok(public.progression_entry_streak_qualifies_on_date(
  '{"streakRuleMode":"same-as-success","metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}],"qualificationRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5}}'::jsonb,
  '{"a":2,"b":3}'::jsonb, 'recorded', '2026-01-15'::date
), 'same-as-success streaks use the Combined Sum success evaluator');

select ok(public.progression_entry_streak_qualifies_on_date(
  '{"streakRuleMode":"custom","streakRule":{"kind":"combined-sum","metricIds":["a","b"],"target":5},"metrics":[{"id":"a","valueType":"quantity","unit":"items"},{"id":"b","valueType":"quantity","unit":"items"}]}'::jsonb,
  '{"a":2,"b":3}'::jsonb, 'recorded', '2026-01-15'::date
), 'custom streaks can use Combined Sum independently');

select * from finish();
rollback;
