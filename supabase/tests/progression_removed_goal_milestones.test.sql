begin;
select plan(27);

insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000094','removed-goal-milestones@example.test');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000094';

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000940','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000941','schema_version',1,'kind','goal','status','active','name','Read a book',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000941','kind','goal','status','active','name','Read a book',
   'createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-2)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','thresholds',jsonb_build_object('direction','increase','minimum',1,'target',10,'streakQualification','minimum'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
   'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'typed goal milestone tracker is accepted');

select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000944','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000945','tracker_id','00000000-0000-4000-8000-000000000941','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('pages',12),'created_at',clock_timestamp())
))->>'status','applied'::text,'threshold crossing is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),25::integer,
 'eligible milestone receives the existing 25 XP reward');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000946','tracker',1,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000941','schema_version',1,'kind','goal','status','active','name','Read a book',
  'created_at',current_date::text||'T00:00:00Z','updated_at',clock_timestamp(),
  'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000941','kind','goal','status','active','name','Read a book',
   'createdAt',current_date::text||'T00:00:00Z','updatedAt',clock_timestamp(),'startDate',(current_date-2)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','thresholds',jsonb_build_object('direction','increase','minimum',1,'target',10,'streakQualification','minimum'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),'milestones','[]'::jsonb))
))->>'status','applied'::text,'removing an achieved milestone definition is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),0::integer,
 'removing its definition reverses the active milestone award');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000094' and reason_code='AWARD_REVERSAL'),1::bigint,
 'removal keeps one linked reversal in the append-only ledger');
select is((select progress from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000094' and achievement_id='milestone-maker'),0::numeric,
 'removal updates milestone achievement progress');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000947','tracker',2,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000941','schema_version',1,'kind','goal','status','active','name','Read a book',
  'created_at',current_date::text||'T00:00:00Z','updated_at',clock_timestamp(),
  'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000941','kind','goal','status','active','name','Read a book',
   'createdAt',current_date::text||'T00:00:00Z','updatedAt',clock_timestamp(),'startDate',(current_date-2)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','thresholds',jsonb_build_object('direction','increase','minimum',1,'target',10,'streakQualification','minimum'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
   'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'restoring the same milestone ID is accepted');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),25::integer,
 'requalification creates a new active milestone award');
select is((select generation from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),3,
 'requalification advances the award generation');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000948','tracker',3,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000941','schema_version',1,'kind','goal','status','active','name','Read a book',
  'created_at',current_date::text||'T00:00:00Z','updated_at',clock_timestamp(),
  'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000941','kind','goal','status','active','name','Read a book',
   'createdAt',current_date::text||'T00:00:00Z','updatedAt',clock_timestamp(),'startDate',(current_date-2)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','thresholds',jsonb_build_object('direction','increase','minimum',1,'target',10,'streakQualification','minimum'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
   'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','position',0))))
))->>'status','applied'::text,'targetless milestone definition is accepted as a configuration');
reset role;
select is((select current_xp from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),0::integer,
 'clearing a milestone target reverses its active award');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000094' and reason_code='AWARD_REVERSAL'),2::bigint,
 'clearing a target records a second linked reversal');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000949','tracker',4,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000941','schema_version',1,'kind','goal','status','active','name','Read a book',
  'created_at',current_date::text||'T00:00:00Z','updated_at',clock_timestamp(),
  'definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000941','kind','goal','status','active','name','Read a book',
   'createdAt',current_date::text||'T00:00:00Z','updatedAt',clock_timestamp(),'startDate',(current_date-2)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','thresholds',jsonb_build_object('direction','increase','minimum',1,'target',10,'streakQualification','minimum'))),
   'schedule',jsonb_build_object('kind','every-day'),'scheduling',jsonb_build_object('mode','ongoing'),
   'milestones',jsonb_build_array(jsonb_build_object('id','checkpoint-10','title','Reach ten','description','','metricId','pages','targetValue',10,'position',0))))
))->>'status','applied'::text,'a target may be restored for the same stable milestone ID');
reset role;
select is((select current_xp || ':' || generation from public.progression_award_state where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),'25:5'::text,
 'requalification after target restoration advances the next generation');
select lives_ok($$select public.reconcile_progression_goal_tracker('00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000941');$$,
 'first repeated reconciliation succeeds');
select lives_ok($$select public.reconcile_progression_goal_tracker('00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000941');$$,
 'second repeated reconciliation succeeds');
select is((select count(*) from public.progression_events where user_id='00000000-0000-4000-8000-000000000094' and reason_code='GOAL_MILESTONE'),3::bigint,
 'reconciliation retries do not duplicate milestone award generations');
select ok(exists(select 1 from pg_indexes where schemaname='public' and indexname='progression_award_state_active_goal_milestones_idx'),
 'active goal milestone lookup uses the partial reconciliation index');
select ok(exists(select 1 from pg_trigger where tgname='tracker_entry_definition_reconciliation_lock' and not tgisinternal),
 'entry writes acquire the tracker definition reconciliation lock');

set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000950','tracker',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000951','schema_version',1,'kind','habit','status','active','name','Mood check',
  'created_at',current_date::text||'T00:00:00Z','definition',jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000951','kind','habit','status','active','name','Mood check',
   'createdAt',current_date::text||'T00:00:00Z','startDate',(current_date-1)::text,
   'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
   'customFields',jsonb_build_array(jsonb_build_object('id','mood','name','Mood','type','text','required',false,'position',0)),
   'schedule',jsonb_build_object('kind','every-day'),'milestones','[]'::jsonb))
))->>'status','applied'::text,'custom field tracker is accepted');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000952','tracker_entry',null,
 jsonb_build_object('id','00000000-0000-4000-8000-000000000953','tracker_id','00000000-0000-4000-8000-000000000951','entry_date',current_date::text,
  'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','Focused'),'created_at',clock_timestamp())
))->>'status','applied'::text,'historical custom field value is accepted');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000954','tracker',1,
 (select jsonb_build_object('id',tracker.id,'schema_version',tracker.schema_version,'kind',tracker.kind,'status',tracker.status,'name',tracker.name,
  'created_at',tracker.created_at,'updated_at',clock_timestamp(),'deleted_at',tracker.deleted_at,
  'definition',jsonb_set(tracker.definition,'{customFields,0,name}','"Energy"'))
  from public.trackers tracker where tracker.id='00000000-0000-4000-8000-000000000951')
))->>'status','conflict'::text,
 'custom field meaning cannot be changed through the sync RPC when historical availability is unversioned');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000955','tracker',1,
 (select jsonb_build_object('id',tracker.id,'schema_version',tracker.schema_version,'kind',tracker.kind,'status',tracker.status,'name',tracker.name,
  'created_at',tracker.created_at,'updated_at',clock_timestamp(),'deleted_at',tracker.deleted_at,
  'definition',jsonb_set(tracker.definition,'{customFields,0,retiredAt}',to_jsonb(clock_timestamp()::text)))
  from public.trackers tracker where tracker.id='00000000-0000-4000-8000-000000000951')
))->>'status','conflict'::text,'custom field retirement is blocked when availability dates are unknown');
reset role;
select is((select entry_values->>'field:mood' from public.tracker_entries where id='00000000-0000-4000-8000-000000000953'),'Focused',
 'blocked field edits preserve the historical value');
set local role authenticated;
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000956','tracker',1,
 (select jsonb_build_object('id',tracker.id,'schema_version',tracker.schema_version,'kind',tracker.kind,'status',tracker.status,'name',tracker.name,
  'created_at',tracker.created_at,'updated_at',clock_timestamp(),'deleted_at',tracker.deleted_at,
  'definition',jsonb_set(tracker.definition,'{customFields,0,type}','"number"'))
  from public.trackers tracker where tracker.id='00000000-0000-4000-8000-000000000951')
))->>'status','conflict'::text,'custom-field value type edits remain recoverable conflicts');
select is((public.apply_tracker_sync_operation(
 '00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000957','tracker',1,
 (select jsonb_build_object('id',tracker.id,'schema_version',tracker.schema_version,'kind',tracker.kind,'status',tracker.status,'name',tracker.name,
  'created_at',tracker.created_at,'updated_at',clock_timestamp(),'deleted_at',tracker.deleted_at,
  'definition',jsonb_set(tracker.definition,'{customFields}','[]'::jsonb))
  from public.trackers tracker where tracker.id='00000000-0000-4000-8000-000000000951')
))->>'status','conflict'::text,'custom fields cannot be removed when historical availability is not versioned');

select * from finish();
rollback;
