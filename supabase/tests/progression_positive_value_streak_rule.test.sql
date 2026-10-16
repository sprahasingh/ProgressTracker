begin;
set local statement_timeout = '60s';
select plan(24);

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000991','positive-streak-rule@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000000991','UTC',true)
on conflict(user_id) do update set timezone='UTC',timezone_configured=true;

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000991';
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000991','00000000-0000-4000-8000-000000000993','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000992','schema_version',8,'kind','habit','status','active','name','Positive streak rule',
  'created_at',clock_timestamp(),'definition',jsonb_build_object(
   'schemaVersion',8,'id','00000000-0000-4000-8000-000000000992','kind','habit','status','active','name','Positive streak rule',
   'createdAt',current_date::text||'T00:00:00Z','startDate',current_date::text,'metrics',jsonb_build_array(
    jsonb_build_object('id','pages','name','Pages','valueType','quantity','precision',jsonb_build_object('decimalPlaces',2,'increment',0.01)),
    jsonb_build_object('id','minutes','name','Minutes','valueType','duration','precision',jsonb_build_object('decimalPlaces',2,'increment',0.01))),
   'schedule',jsonb_build_object('kind','every-day'),
   'qualificationRule',jsonb_build_object('kind','comparison','metricId','minutes','operator','at-least','value',5),
   'streakRuleMode','custom','streakRule',jsonb_build_object('kind','comparison','metricId','pages','operator','greater-than','value',0),
   'customFields','[]'::jsonb,'milestones','[]'::jsonb)))
)->>'status','applied','the server accepts a persisted custom Streak Rule using greater-than zero');
reset role;

select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb),
 'quantity greater-than-zero rules pass server validation');
select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"minutes","valueType":"duration"}]}'::jsonb,
 '{"kind":"comparison","metricId":"minutes","operator":"greater-than","value":0}'::jsonb),
 'duration greater-than-zero rules pass server validation');

select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'missing numeric observations do not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":null}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'null numeric observations do not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":""}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'blank numeric observations do not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":0}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'numeric zero does not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":12}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb),
 'positive integers qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":0.01}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb),
 'positive decimal values qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,'{"pages":-0.01}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'negative values do not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"minutes","valueType":"duration"}]}'::jsonb,'{"minutes":0.25}'::jsonb,
 '{"kind":"comparison","metricId":"minutes","operator":"greater-than","value":0}'::jsonb),
 'positive duration decimals qualify');

select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"steps","valueType":"checklist","checklistItems":[{"id":"one"},{"id":"two"},{"id":"three"}]}]}'::jsonb,
 '{"kind":"comparison","metricId":"steps","operator":"greater-than","value":0}'::jsonb),
 'checklist greater-than-zero rules pass server validation');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"steps","valueType":"checklist","checklistItems":[{"id":"one"},{"id":"two"},{"id":"three"}]}]}'::jsonb,
 '{"steps":{"one":false,"two":false,"three":false}}'::jsonb,
 '{"kind":"comparison","metricId":"steps","operator":"greater-than","value":0}'::jsonb) is false,
 'checklists with no completed items do not qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"steps","valueType":"checklist","checklistItems":[{"id":"one"},{"id":"two"},{"id":"three"}]}]}'::jsonb,
 '{"steps":{"one":true,"two":false,"three":false}}'::jsonb,
 '{"kind":"comparison","metricId":"steps","operator":"greater-than","value":0}'::jsonb),
 'one completed checklist item qualifies');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"steps","valueType":"checklist","checklistItems":[{"id":"one"},{"id":"two"},{"id":"three"}]}]}'::jsonb,
 '{"steps":{"one":true,"two":true,"three":true}}'::jsonb,
 '{"kind":"comparison","metricId":"steps","operator":"greater-than","value":0}'::jsonb),
 'multiple completed checklist items qualify');
select ok(public.progression_rule_qualifies(
 '{"metrics":[{"id":"steps","valueType":"checklist","checklistItems":[{"id":"one"}]}]}'::jsonb,'{}'::jsonb,
 '{"kind":"comparison","metricId":"steps","operator":"greater-than","value":0}'::jsonb) is false,
 'missing checklist observations do not qualify');

select ok(public.progression_entry_success_qualifies(
 (select definition from public.trackers where id='00000000-0000-4000-8000-000000000992'),
 '{"pages":0,"minutes":5}'::jsonb,'recorded'),
 'a Success Rule can pass independently while the positive Streak Rule fails');
select ok(public.progression_entry_streak_qualifies(
 (select definition from public.trackers where id='00000000-0000-4000-8000-000000000992'),
 '{"pages":0,"minutes":5}'::jsonb,'recorded') is false,
 'a failed positive Streak Rule does not inherit success qualification');
select ok(public.progression_entry_success_qualifies(
 (select definition from public.trackers where id='00000000-0000-4000-8000-000000000992'),
 '{"pages":0.25,"minutes":0}'::jsonb,'recorded') is false,
 'a positive Streak Rule value does not inherit Success Rule qualification');
select ok(public.progression_entry_streak_qualifies(
 (select definition from public.trackers where id='00000000-0000-4000-8000-000000000992'),
 '{"pages":0.25,"minutes":0}'::jsonb,'recorded'),
 'positive streak progress qualifies independently of success');
select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,
 '{"kind":"comparison","metricId":"pages","operator":"at-least","value":0}'::jsonb) is false,
 'the existing invalid at-least-zero rule remains rejected');
select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"done","valueType":"boolean"}]}'::jsonb,
 '{"kind":"comparison","metricId":"done","operator":"greater-than","value":0}'::jsonb) is false,
 'boolean rules do not accept numeric comparisons');
select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,
 '{"kind":"comparison","metricId":"pages","value":0}'::jsonb) is false,
 'comparisons without an operator are rejected');
select ok(public.tracker_rule_is_valid(
 '{"metrics":[{"id":"pages","valueType":"quantity"}]}'::jsonb,
 '{"metricId":"pages","operator":"greater-than","value":0}'::jsonb) is false,
 'rules without a kind are rejected');

select * from finish();
rollback;
