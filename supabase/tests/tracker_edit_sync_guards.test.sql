begin;
select plan(49);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000821', 'tracker-edit-guard@example.test');
insert into public.app_settings (id, user_id, timezone, timezone_configured)
values ('general', '00000000-0000-4000-8000-000000000821', 'UTC', true);

with evaluation as (
  select jsonb_build_object(
    'schedule', jsonb_build_object('kind','every-day'),
    'scheduling', jsonb_build_object('mode','ongoing'),
    'metrics', jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule', jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
    'streakRuleMode','same-as-success','strictMode',false
  ) as value
), tracker_definition as (
  select jsonb_build_object(
    'schemaVersion',10,'id','00000000-0000-4000-8000-000000000822','name','Guarded tracker','kind','habit','status','active',
    'schedule',value->'schedule','scheduling',value->'scheduling','metrics',value->'metrics',
    'qualificationRule',value->'qualificationRule','streakRuleMode','same-as-success','strictMode',false,
    'customFields',jsonb_build_array(
      jsonb_build_object('id','mood','name','Mood','type','single-select','required',false,'position',0,'options',jsonb_build_array('Focused','Tired')),
      jsonb_build_object('id','minutes','name','Minutes','type','integer','required',false,'position',1),
      jsonb_build_object('id','details','name','Details','type','text','required',true,'position',2),
      jsonb_build_object('id','tags','name','Tags','type','multi-select','required',false,'position',3,'options',jsonb_build_array('Focused','Tired')),
      jsonb_build_object('id','enabled','name','Enabled','type','boolean','required',false,'position',4)
    ),'milestones','[]'::jsonb,
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id','guard-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,'application','baseline',
      'recordedAt',clock_timestamp(),'evaluation',value
    ))
  ) as value from evaluation
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition)
select '00000000-0000-4000-8000-000000000822','00000000-0000-4000-8000-000000000821',10,'habit','active','Guarded tracker',value
from tracker_definition;

update public.trackers set created_at = clock_timestamp() - interval '30 days'
where id = '00000000-0000-4000-8000-000000000822';

insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note,created_at,updated_at)
values ('00000000-0000-4000-8000-000000000826','00000000-0000-4000-8000-000000000821',
  '00000000-0000-4000-8000-000000000822',current_date - 1,'recorded',
  '{"done":true,"field:mood":"Focused","field:minutes":12,"field:details":"saved history"}'::jsonb,
  'historical field values','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');

with legacy_definition as (
  select jsonb_build_object(
    'schemaVersion',9,'id','00000000-0000-4000-8000-000000000827','name','Legacy tracker','kind','habit','status','active',
    'schedule',jsonb_build_object('kind','every-day'),'metrics',jsonb_build_array(
      jsonb_build_object('id','done','name','Done','valueType','boolean'),
      jsonb_build_object('id','legacy-pages','name','Legacy pages','valueType','quantity','unit','pages','precision',jsonb_build_object('decimalPlaces',2,'increment',0.25))),
    'customFields',jsonb_build_array(jsonb_build_object('id','mood','name','Mood','type','text','required',false,'position',0)),
    'milestones','[]'::jsonb
  ) as value
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000827','00000000-0000-4000-8000-000000000821',9,'habit','active','Legacy tracker',value,clock_timestamp() - interval '30 days'
from legacy_definition;
insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000000847','00000000-0000-4000-8000-000000000821',
  '00000000-0000-4000-8000-000000000827',current_date - 1,'recorded',
  '{"done":true,"field:mood":"legacy saved"}'::jsonb,'legacy historical field value');

-- Date-effective definitions control both numeric increments and checklist
-- item membership. The old checklist item remains valid only before the
-- newer snapshot takes effect.
with old_metrics as (
  select jsonb_build_array(
    jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','precision',jsonb_build_object('decimalPlaces',2,'increment',0.25)),
    jsonb_build_object('id','routine','name','Routine','valueType','checklist','checklistItems',jsonb_build_array(
      jsonb_build_object('id','read','label','Read','position',0)))
  ) as value
), new_metrics as (
  select jsonb_build_array(
    jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages','precision',jsonb_build_object('decimalPlaces',2,'increment',0.25)),
    jsonb_build_object('id','routine','name','Routine','valueType','checklist','checklistItems',jsonb_build_array(
      jsonb_build_object('id','review','label','Review','position',0)))
  ) as value
), definition as (
  select jsonb_build_object(
    'schemaVersion',10,'id','00000000-0000-4000-8000-000000000868','name','Typed guard','kind','habit','status','active',
    'schedule',jsonb_build_object('kind','every-day'),'metrics',new_metrics.value,'customFields','[]'::jsonb,'milestones','[]'::jsonb,
    'ruleVersions',jsonb_build_array(
      jsonb_build_object('id','typed-old','effectiveFrom',(current_date - 30)::text,'revision',1,'application','baseline',
        'recordedAt',clock_timestamp(),'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'metrics',old_metrics.value)),
      jsonb_build_object('id','typed-new','effectiveFrom',(current_date - 1)::text,'revision',2,'application','apply-from-today',
        'recordedAt',clock_timestamp(),'evaluation',jsonb_build_object('schedule',jsonb_build_object('kind','every-day'),'metrics',new_metrics.value))
    )
  ) as value from old_metrics cross join new_metrics
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000868','00000000-0000-4000-8000-000000000821',10,'habit','active','Typed guard',value,
  clock_timestamp() - interval '30 days' from definition;

-- A current v10 configuration can contain a measure introduced after its
-- baseline snapshot. All-history edits must not flatten that availability gap.
with existing as (
  select definition from public.trackers where id='00000000-0000-4000-8000-000000000822'
), versions as (
  select definition->'ruleVersions'->0 as baseline,
    (definition->'ruleVersions'->0->'evaluation') || jsonb_build_object(
      'metrics',(definition->'ruleVersions'->0->'evaluation'->'metrics') || jsonb_build_array(
        jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages')),
      'qualificationRule',jsonb_build_object('kind','all','operands',jsonb_build_array(
        jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
        jsonb_build_object('kind','comparison','metricId','pages','operator','at-least','value',1)))
    ) as later_evaluation from existing
), proposed as (
  select definition || jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000856','name','Later measure dependency',
    'metrics',later_evaluation->'metrics','qualificationRule',later_evaluation->'qualificationRule',
    'ruleVersions',jsonb_build_array(baseline,jsonb_build_object('id','introduced-pages','effectiveFrom',(current_date - 10)::text,
      'revision',2,'application','apply-from-today','recordedAt',clock_timestamp(),'evaluation',later_evaluation))
  ) as definition from existing cross join versions
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000856','00000000-0000-4000-8000-000000000821',10,'habit','active',
  'Later measure dependency',definition,clock_timestamp() - interval '30 days' from proposed;

insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000858','00000000-0000-4000-8000-000000000821',10,'habit','active',
  'Rule-dependent milestone',
  definition || jsonb_build_object('id','00000000-0000-4000-8000-000000000858','name','Rule-dependent milestone',
    'milestones',jsonb_build_array(jsonb_build_object('id','success-days','title','Successful days','description','',
      'type','successful-days','targetValue',5,'position',0))),
  clock_timestamp() - interval '30 days'
from public.trackers where id='00000000-0000-4000-8000-000000000822';

insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000864','00000000-0000-4000-8000-000000000821',10,'habit','active',
  'Missing historical measure input',
  definition || jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000864','name','Missing historical measure input',
    'metrics',definition->'metrics' || jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages')),
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id','missing-input-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,
      'application','baseline','recordedAt',clock_timestamp(),
      'evaluation',(definition->'ruleVersions'->0->'evaluation') || jsonb_build_object(
        'metrics',(definition->'ruleVersions'->0->'evaluation'->'metrics') ||
          jsonb_build_array(jsonb_build_object('id','pages','name','Pages','valueType','quantity','unit','pages'))
      )
    ))
  ),
  clock_timestamp() - interval '30 days'
from public.trackers where id='00000000-0000-4000-8000-000000000822';
insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000000866','00000000-0000-4000-8000-000000000821',
  '00000000-0000-4000-8000-000000000864',current_date - 1,'recorded','{"done":true}'::jsonb,'pages value was not recorded');

select is((select array_agg(metric_id order by metric_id) from public.tracker_edit_rule_metric_ids(
  '{"kind":"all","operands":[{"kind":"comparison","metricId":"done"},{"kind":"any","operands":[{"kind":"threshold","metricId":"pages"}]}]}'::jsonb
)),array['done','pages']::text[],'server dependency extraction recursively visits nested success and streak rules');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000821';

select is(public.tracker_edit_sync_guards_contract(),'tracker-edit-sync-guards:v1'::text,
  'authenticated clients can detect the installed tracker edit guard contract');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000823','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000823','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('unknown_measure',1),'note','')
))->>'status','conflict'::text,'server rejects a measure unavailable in the configuration effective on the check-in date');
select is((select count(*) from public.tracker_entries where id='00000000-0000-4000-8000-000000000823'),0::bigint,
  'a rejected date-specific measure is not inserted');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000869','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000869','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',(current_date - 3)::text,'outcome','recorded','entry_values',jsonb_build_object('pages',0.5,'routine',jsonb_build_object('read',true)),'note','valid historical typed values')
))->>'status','applied'::text,'date-effective numeric increments and checklist item IDs accept valid values');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000870','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000870','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('pages',0.3),'note','off increment')
))->>'status','conflict'::text,'server rejects numeric values outside the date-effective increment');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000870','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000870','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('pages',0.25),'note','corrected after conflict')
))->>'status','applied'::text,'a rejected numeric operation remains retryable with corrected values');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000871','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000871','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_object('unknown',true)),'note','unknown checklist item')
))->>'status','conflict'::text,'server rejects checklist item IDs absent from the date-effective definition');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000872','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000872','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_object('review','yes')),'note','malformed checklist')
))->>'status','conflict'::text,'server rejects non-boolean checklist item values');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000873','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000873','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',(current_date - 2)::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_object('read',true),'pages',0.25),'note','historical definition')
))->>'status','applied'::text,'historical checklist membership uses the earlier snapshot');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000874','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000874','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',(current_date - 2)::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_object('review',true)),'note','future item in history')
))->>'status','conflict'::text,'server rejects checklist items introduced after the requested historical date');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000876','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000876','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_array(true)),'note','legacy positional checklist')
))->>'status','applied'::text,'legacy positional boolean arrays remain valid within date-effective checklist length');
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000877','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000877','tracker_id','00000000-0000-4000-8000-000000000868',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values',jsonb_build_object('routine',jsonb_build_array(true,false)),'note','extra checklist position')
))->>'status','conflict'::text,'legacy positional arrays cannot reference positions absent from the effective checklist');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000875','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000875','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',(current_date - 3)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'legacy-pages',0.3),'note','legacy precision compatibility')
))->>'status','applied'::text,'legacy v9 measure writes retain their existing validation contract');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000824','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000824','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object(
      'done',true,'field:mood','Focused','field:minutes',15,'field:details','today'
      ,'field:tags',jsonb_build_array('Focused','Tired'),'field:enabled',true
    ),'note','')
))->>'status','applied'::text,'valid same-day custom-field values and measures sync');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000828','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000828','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:unknown','x','field:details','ok'),'note','')
))->>'status','conflict'::text,'unknown custom-field IDs are recoverably rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000829','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000829','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:minutes','15','field:details','ok'),'note','')
))->>'status','conflict'::text,'custom-field value types are checked by the server');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000830','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000830','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','Calm','field:details','ok'),'note','')
))->>'status','conflict'::text,'single-select options are checked by the server');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000840','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000840','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:tags',jsonb_build_array('Focused','Unknown'),'field:details','ok'),'note','')
))->>'status','conflict'::text,'multi-select options are checked by the server');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000841','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000841','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:enabled','yes','field:details','ok'),'note','')
))->>'status','conflict'::text,'boolean custom fields reject non-boolean values');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000842','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000842','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:minutes',1.5,'field:details','ok'),'note','')
))->>'status','conflict'::text,'integer custom fields reject fractional values');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000828','tracker_entry',1,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000824','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object(
      'done',true,'field:mood','Focused','field:minutes',15,'field:details','corrected retry',
      'field:tags',jsonb_build_array('Focused'),'field:enabled',true
    ),'note','corrected after conflict')
))->>'status','applied'::text,'a corrected retry after a validation conflict can apply without a stale receipt');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000831','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000831','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','Focused'),'note','')
))->>'status','conflict'::text,'required fields are enforced for new same-day recorded entries');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000832','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000832','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:','x','field:details','ok'),'note','')
))->>'status','conflict'::text,'empty custom-field IDs are rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000843','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000843','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_array(true),'note','')
))->>'status','conflict'::text,'malformed entry value containers are recoverably rejected');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000833','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000833','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',(current_date - 2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:minutes',13,'field:details','backdated'),'note','')
))->>'status','conflict'::text,'new historical custom-field values conflict when field availability cannot be proven');

reset role;
update public.trackers
set definition = jsonb_set(definition, '{customFields,0,retiredAt}', to_jsonb(clock_timestamp()::text)),
    updated_at = clock_timestamp()
where id = '00000000-0000-4000-8000-000000000822';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000821';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000834','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000834','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',(current_date - 3)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','Focused'),'note','created offline before retirement')
))->>'status','conflict'::text,'new offline entries for a retired field are retained as recoverable conflicts');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000834','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000834','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',(current_date - 3)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','corrected after field conflict')
))->>'status','applied'::text,'the queued entry can be retried after removing its ambiguous retired-field value');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000835','tracker_entry',1,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000826','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values',
      '{"done":true,"field:mood":"Focused","field:minutes":12,"field:details":"saved history"}'::jsonb,
    'note','edited historical note')
))->>'status','applied'::text,'existing historical field values remain editable when preserved unchanged after retirement');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000836','tracker_entry',2,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000826','tracker_id','00000000-0000-4000-8000-000000000822',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values',
      '{"done":true,"field:mood":"Tired","field:minutes":12,"field:details":"saved history"}'::jsonb,'note','invalid retired edit')
))->>'status','conflict'::text,'retired field values cannot be changed on an existing historical entry');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000837','tracker',
  (select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000822'),
  (select jsonb_build_object('id',id,'schema_version',schema_version,'kind',kind,'status',status,'name',name,
    'definition',jsonb_set(definition,'{customFields}',definition->'customFields' ||
      jsonb_build_array(jsonb_build_object('id','energy','name','Energy','type','text','required',false,'position',3))))
   from public.trackers where id='00000000-0000-4000-8000-000000000822')
))->>'status','conflict'::text,'v10 custom-field structural changes are blocked without date-effective field snapshots');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000838','tracker',
  (select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000822'),
  (select jsonb_build_object('id',id,'schema_version',schema_version,'kind',kind,'status',status,'name',name,
    'definition',jsonb_set(definition,'{customFields,0,position}','4'::jsonb))
   from public.trackers where id='00000000-0000-4000-8000-000000000822')
))->>'status','applied'::text,'presentation ordering changes remain allowed');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000839','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000839','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','legacy value'),'note','legacy queued entry')
))->>'status','applied'::text,'valid same-day v9 custom-field entries pass authoritative field validation');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000846','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000846','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',current_date::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:unknown','legacy value'),'note','unknown legacy field')
))->>'status','conflict'::text,'unknown custom-field references in legacy queued writes remain recoverable conflicts');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000851','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000851','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',(current_date - 2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true,'field:mood','Focused'),'note','offline legacy check-in')
))->>'status','conflict'::text,'ambiguous historical custom-field values in a legacy offline entry are recoverable conflicts');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000851','tracker_entry',null,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000851','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',(current_date - 2)::text,'outcome','recorded','entry_values',jsonb_build_object('done',true),'note','corrected legacy offline entry')
))->>'status','applied'::text,'a corrected legacy retry applies without discarding the queued operation');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000850','tracker',1,
  (select jsonb_build_object('id',id,'schema_version',schema_version,'kind',kind,'status',status,'name',name,
    'definition',jsonb_set(definition,'{customFields}',definition->'customFields' ||
      jsonb_build_array(jsonb_build_object('id','energy','name','Energy','type','text','required',false,'position',1))))
   from public.trackers where id='00000000-0000-4000-8000-000000000827')
))->>'status','conflict'::text,'legacy custom-field structural changes are blocked when historical availability cannot be versioned');

reset role;
update public.trackers set definition = jsonb_set(definition, '{customFields,0,retiredAt}', to_jsonb(clock_timestamp()::text))
where id = '00000000-0000-4000-8000-000000000827';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000821';

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000848','tracker_entry',
  (select server_revision from public.tracker_entries where id='00000000-0000-4000-8000-000000000847'),
  jsonb_build_object('id','00000000-0000-4000-8000-000000000847','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values','{"done":true,"field:mood":"legacy saved"}'::jsonb,'note','edited legacy note')
))->>'status','applied'::text,'existing legacy historical values remain editable when preserved unchanged after retirement');

select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000849','tracker_entry',
  (select server_revision from public.tracker_entries where id='00000000-0000-4000-8000-000000000847'),
  jsonb_build_object('id','00000000-0000-4000-8000-000000000847','tracker_id','00000000-0000-4000-8000-000000000827',
    'entry_date',(current_date - 1)::text,'outcome','recorded','entry_values','{"done":true,"field:mood":"changed"}'::jsonb,'note','changed legacy field')
))->>'status','conflict'::text,'retired legacy field values cannot be changed by an offline edit');

with old_tracker as (
  select definition from public.trackers where id='00000000-0000-4000-8000-000000000822'
), new_definition as (
  select jsonb_set(
    jsonb_set(definition,'{metrics}',(definition->'metrics') || jsonb_build_array(jsonb_build_object('id','extra','name','Extra','valueType','boolean'))),
    '{ruleVersions}',
    (definition->'ruleVersions') || jsonb_build_array(jsonb_build_object(
      'id','guard-today','effectiveFrom',current_date::text,'revision',2,'application','apply-from-today',
      'historyPolicy','apply-from-today','recordedAt',clock_timestamp(),
      'evaluation',jsonb_set(definition->'ruleVersions'->0->'evaluation','{metrics}',
        (definition->'metrics') || jsonb_build_array(jsonb_build_object('id','extra','name','Extra','valueType','boolean')))
    ))
  ) as value from old_tracker
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000825','tracker',1,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000822','schema_version',10,'kind','habit','status','active','name','Guarded tracker',
    'definition',value)
))->>'status','conflict'::text,'a check-in created after confirmation makes a structural same-day boundary recoverably stale')
from new_definition;

with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000856'
), all_history_definition as (
  select server_revision,jsonb_set(definition,'{ruleVersions}',jsonb_build_array(jsonb_build_object(
    'id','all-history-pages','effectiveFrom',(current_date - 30)::text,'revision',3,'application','recalculate-all-history',
    'historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),
    'evaluation',definition->'ruleVersions'->1->'evaluation'
  ))) as definition from current_tracker
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000857','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000856','schema_version',10,'kind','habit','status','active',
    'name','Later measure dependency','definition',definition)
))->>'status','conflict'::text,'server rejects all-history recalculation when a referenced measure was absent from the baseline snapshot')
from all_history_definition;

with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000858'
), changed as (
  select server_revision,definition,
    (definition->'ruleVersions'->0->'evaluation') || jsonb_build_object('qualificationRule',
      jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',false)) as evaluation
  from current_tracker
), all_history_definition as (
  select server_revision,definition || jsonb_build_object(
    'qualificationRule',evaluation->'qualificationRule',
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','all-history-milestone','effectiveFrom',(current_date - 30)::text,
      'revision',2,'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),'evaluation',evaluation))
  ) as definition from changed
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000859','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000858','schema_version',10,'kind','habit','status','active',
    'name','Rule-dependent milestone','definition',definition)
))->>'status','conflict'::text,'server rejects all-history rule changes that could alter successful-day milestone rewards')
from all_history_definition;

with legacy_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000827'
), prospective as (
  select server_revision,definition || jsonb_build_object('schemaVersion',10,'ruleVersions',jsonb_build_array(jsonb_build_object(
    'id','legacy-all-history','effectiveFrom',(current_date - 30)::text,'revision',1,'application','recalculate-all-history',
    'historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),
    'evaluation',jsonb_build_object('schedule',definition->'schedule','startDate',null,'deadline',null,'scheduling',null,
      'metrics',definition->'metrics','qualificationRule',null,'streakRuleMode',null,'streakRule',null,'strictMode',false)
  ))) as definition from legacy_tracker
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000860','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000827','schema_version',10,'kind','habit','status','active',
    'name','Legacy tracker','definition',definition)
))->>'status','conflict'::text,'server rejects all-history recalculation when a legacy tracker has no date-effective measure history')
from prospective;

reset role;
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000861','00000000-0000-4000-8000-000000000821',10,'habit','active',
  'Missing baseline coverage',
  definition || jsonb_build_object('id','00000000-0000-4000-8000-000000000861','name','Missing baseline coverage',
    'ruleVersions',jsonb_build_array(jsonb_build_object('id','late-baseline','effectiveFrom',(current_date - 10)::text,
      'revision',1,'application','baseline','recordedAt',clock_timestamp(),'evaluation',definition->'ruleVersions'->0->'evaluation'))),
  clock_timestamp() - interval '30 days'
from public.trackers where id='00000000-0000-4000-8000-000000000822';

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000821';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000861'
), all_history_definition as (
  select server_revision,definition || jsonb_build_object('ruleVersions',jsonb_build_array(jsonb_build_object(
    'id','all-history-after-missing-start','effectiveFrom',(current_date - 30)::text,'revision',2,
    'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),
    'evaluation',definition->'ruleVersions'->0->'evaluation'
  ))) as definition from current_tracker
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000862','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000861','schema_version',10,'kind','habit','status','active',
    'name','Missing baseline coverage','definition',definition)
))->>'status','conflict'::text,'server rejects all-history when date-effective snapshots do not cover the tracker history start')
from all_history_definition;

with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000864'
), proposed as (
  select server_revision,definition,
    (definition->'ruleVersions'->-1->'evaluation') || jsonb_build_object('qualificationRule',
      jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',false)) as evaluation
  from current_tracker
), all_history_definition as (
  select server_revision,definition || jsonb_build_object(
    'qualificationRule',evaluation->'qualificationRule',
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id','all-history-missing-input','effectiveFrom',(current_date - 30)::text,'revision',2,
      'application','recalculate-all-history','historyPolicy','recalculate-all-history','recordedAt',clock_timestamp(),
      'evaluation',evaluation
    ))
  ) as definition from proposed
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000865','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000864','schema_version',10,'kind','habit','status','active',
    'name','Missing historical measure input','definition',definition)
))->>'status','conflict'::text,'server rejects all-history when a recorded date lacks an active measure value')
from all_history_definition;

with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000822'
), retired_evaluation as (
  select server_revision,definition,
    jsonb_set(definition->'ruleVersions'->-1->'evaluation','{metrics}',
      jsonb_build_array((definition->'ruleVersions'->-1->'evaluation'->'metrics'->0)
        || jsonb_build_object('retiredAt',clock_timestamp()::text))) as evaluation
  from current_tracker
), proposal as (
  select server_revision,definition || jsonb_build_object(
    'metrics',evaluation->'metrics',
    'ruleVersions',(definition->'ruleVersions') || jsonb_build_array(jsonb_build_object(
      'id','forward-rule-retired-measure','effectiveFrom',(current_date)::text,'revision',2,
      'application','apply-from-today','historyPolicy','apply-from-today','recordedAt',clock_timestamp(),
      'evaluation',evaluation
    ))
  ) as definition from retired_evaluation
)
select is((public.apply_tracker_sync_operation(
  '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000863','tracker',server_revision,
  jsonb_build_object('id','00000000-0000-4000-8000-000000000822','schema_version',10,'kind','habit','status','active',
    'name','Guarded tracker','definition',definition)
))->>'status','conflict'::text,'server rejects newly effective rules referencing a retired measure')
from proposal;

reset role;
with evaluation as (
  select jsonb_build_object(
    'schedule',jsonb_build_object('kind','every-day'),
    'startDate',(current_date - 30)::text,
    'scheduling',jsonb_build_object('mode','ongoing'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true),
    'streakRuleMode','same-as-success','strictMode',false
  ) as value
), definition as (
  select jsonb_build_object(
    'schemaVersion',10,'id','00000000-0000-4000-8000-000000000900','name','Reversal attribution tracker',
    'kind','habit','status','active','schedule',value->'schedule','startDate',value->'startDate',
    'scheduling',value->'scheduling','metrics',value->'metrics','qualificationRule',value->'qualificationRule',
    'streakRuleMode','same-as-success','strictMode',false,'customFields','[]'::jsonb,'milestones','[]'::jsonb,
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id','reversal-attribution-baseline','effectiveFrom',(current_date - 30)::text,'revision',1,
      'application','baseline','recordedAt',clock_timestamp(),'evaluation',value
    ))
  ) as value from evaluation
)
insert into public.trackers (id,user_id,schema_version,kind,status,name,definition,created_at)
select '00000000-0000-4000-8000-000000000900','00000000-0000-4000-8000-000000000821',10,'habit','active',
  'Reversal attribution tracker',value,clock_timestamp() - interval '30 days'
from definition;

insert into public.tracker_entries (id,user_id,tracker_id,entry_date,outcome,entry_values,note)
values ('00000000-0000-4000-8000-000000000901','00000000-0000-4000-8000-000000000821',
  '00000000-0000-4000-8000-000000000900',current_date,'recorded','{"done":true}'::jsonb,'all-history reversal source');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000821';
with current_tracker as (
  select server_revision,definition from public.trackers where id='00000000-0000-4000-8000-000000000900'
), next_evaluation as (
  select server_revision,definition,
    (definition->'ruleVersions'->0->'evaluation') || jsonb_build_object('qualificationRule',
      jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',false)) as evaluation
  from current_tracker
), proposal as (
  select server_revision,definition || jsonb_build_object(
    'qualificationRule',evaluation->'qualificationRule',
    'ruleVersions',jsonb_build_array(jsonb_build_object(
      'id','reversal-attribution-all-history','effectiveFrom',(current_date - 30)::text,'revision',2,
      'application','recalculate-all-history','historyPolicy','recalculate-all-history',
      'recordedAt',clock_timestamp(),'evaluation',evaluation
    ))
  ) as definition from next_evaluation
), saved as (
  select public.apply_tracker_sync_operation(
    '00000000-0000-4000-8000-000000000821','00000000-0000-4000-8000-000000000902','tracker',server_revision,
    jsonb_build_object('id','00000000-0000-4000-8000-000000000900','schema_version',10,'kind','habit',
      'status','active','name','Reversal attribution tracker','definition',definition)
  ) as result from proposal
)
select is((select result->>'status' from saved),'applied'::text,
  'all-history rule edit commits and reconciles the saved check-in');

select is((
  select count(*)::integer
  from public.progression_events reversal
  join public.progression_events award
    on award.user_id=reversal.user_id and award.id=reversal.reverses_event_id
  join public.progression_event_sources award_source
    on award_source.user_id=award.user_id and award_source.event_id=award.id
  join public.progression_event_sources reversal_source
    on reversal_source.user_id=reversal.user_id and reversal_source.event_id=reversal.id
  where reversal.user_id='00000000-0000-4000-8000-000000000821'
    and reversal.reason_code='AWARD_REVERSAL'
    and award_source.tracker_id='00000000-0000-4000-8000-000000000900'
    and award_source.source_id='00000000-0000-4000-8000-000000000901'
    and reversal_source.tracker_id=award_source.tracker_id
    and reversal_source.source_id=award_source.source_id
),1,'check-in XP reversal retains the original tracker and entry attribution');

select is((
  select reversal.xp_delta
  from public.progression_events reversal
  join public.progression_events award on award.user_id=reversal.user_id and award.id=reversal.reverses_event_id
  join public.progression_event_sources source on source.user_id=award.user_id and source.event_id=award.id
  where reversal.user_id='00000000-0000-4000-8000-000000000821'
    and reversal.reason_code='AWARD_REVERSAL'
    and source.tracker_id='00000000-0000-4000-8000-000000000900'
    and source.source_id='00000000-0000-4000-8000-000000000901'
),-10,'all-history check-in award reversal retains the exact XP delta');

reset role;
select * from finish();
rollback;
