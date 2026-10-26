begin;
set local statement_timeout = '60s';
select plan(9);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000005201','historical-award-rules@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000005201','UTC',true);
select public.initialize_progression_account('00000000-0000-4000-8000-000000005201');
update public.progression_account_state set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000005201';
update public.progression_achievement_accounts set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000005201';

insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition) values
 ('00000000-0000-4000-8000-000000005211','00000000-0000-4000-8000-000000005201',10,'habit','active','Versioned increase',current_date-10,
  jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000005211','kind','habit','status','active','name','Versioned increase',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),
    'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
    'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','duration','thresholds',jsonb_build_object('direction','increase','minimum',10,'target',20))),
    'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','target'),'streakRuleMode','same-as-success',
    'ruleVersions',jsonb_build_array(
      jsonb_build_object('id','baseline','effectiveFrom',current_date-10,'revision',1,'application','baseline','recordedAt',clock_timestamp(),
        'evaluation',jsonb_build_object('startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
          'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',5,'target',7))),
          'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','target'),'streakRuleMode','same-as-success')),
      jsonb_build_object('id','new-rule','effectiveFrom',current_date-3,'revision',2,'application','apply-from-today','recordedAt',clock_timestamp(),
        'evaluation',jsonb_build_object('startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
          'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','duration','thresholds',jsonb_build_object('direction','increase','minimum',10,'target',20))),
          'qualificationRule',jsonb_build_object('kind','threshold','metricId','amount','level','target'),'streakRuleMode','same-as-success'))))) ,
 ('00000000-0000-4000-8000-000000005212','00000000-0000-4000-8000-000000005201',10,'habit','active','Versioned decrease zero',current_date-10,
  jsonb_build_object('schemaVersion',10,'id','00000000-0000-4000-8000-000000005212','kind','habit','status','active','name','Versioned decrease zero',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),
    'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
    'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',5,'target',10))),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','amount','operator','equals','value',5),'streakRuleMode','same-as-success',
    'ruleVersions',jsonb_build_array(
      jsonb_build_object('id','baseline','effectiveFrom',current_date-10,'revision',1,'application','baseline','recordedAt',clock_timestamp(),
        'evaluation',jsonb_build_object('startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
          'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','decrease','minimum',0,'target',0))),
          'qualificationRule',jsonb_build_object('kind','comparison','metricId','amount','operator','equals','value',0),'streakRuleMode','same-as-success')),
      jsonb_build_object('id','new-rule','effectiveFrom',current_date-3,'revision',2,'application','apply-from-today','recordedAt',clock_timestamp(),
        'evaluation',jsonb_build_object('startDate',current_date-10,'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'strictMode',false,
          'metrics',jsonb_build_array(jsonb_build_object('id','amount','name','Amount','valueType','quantity','thresholds',jsonb_build_object('direction','increase','minimum',5,'target',10))),
          'qualificationRule',jsonb_build_object('kind','comparison','metricId','amount','operator','equals','value',5),'streakRuleMode','same-as-success')))));

insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values) values
 ('00000000-0000-4000-8000-000000005221','00000000-0000-4000-8000-000000005201','00000000-0000-4000-8000-000000005211',current_date-4,'recorded','{"amount":7}'),
 ('00000000-0000-4000-8000-000000005222','00000000-0000-4000-8000-000000005201','00000000-0000-4000-8000-000000005211',current_date-2,'recorded','{"amount":7}'),
 ('00000000-0000-4000-8000-000000005223','00000000-0000-4000-8000-000000005201','00000000-0000-4000-8000-000000005212',current_date-4,'recorded','{"amount":0}'),
 ('00000000-0000-4000-8000-000000005224','00000000-0000-4000-8000-000000005201','00000000-0000-4000-8000-000000005212',current_date-2,'recorded','{"amount":0}');

select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005221'),10,
  'historical daily XP uses the earlier threshold and qualification rule');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005222'),0,
  'daily XP uses the newer rule on and after its effective date');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005223'),10,
  'historical decrease metric with a zero threshold can qualify under its saved definition');
select is((select current_xp from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005224'),0,
  'current qualification rules do not retroactively qualify the newer zero-value entry');
select is((select public.progression_tracker_definition_for_date(definition,current_date-4)->'metrics'->0->>'valueType'
  from public.trackers where id='00000000-0000-4000-8000-000000005211'),'quantity',
  'historical metric type resolves to the date-effective quantity definition');
select is((select public.progression_tracker_definition_for_date(definition,current_date-2)->'metrics'->0->>'valueType'
  from public.trackers where id='00000000-0000-4000-8000-000000005211'),'duration',
  'later metric type resolves to the date-effective duration definition');
select is((select scoring_version from public.progression_events where id=(select current_event_id from public.progression_award_state where source_id='00000000-0000-4000-8000-000000005223')),2::smallint,
  'historical award reconciliation retains the established ledger scoring version');
select ok(position('v_historic and v_state.current_xp = 0' in pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure))>0,
  'historical cutover guard remains in place for new award creation');
select ok(position('progression_tracker_definition_for_date(v_tracker.definition, p_entry_date)' in pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure))>0,
  'award scorer resolves the historical tracker definition before qualification');

select * from finish();
rollback;
