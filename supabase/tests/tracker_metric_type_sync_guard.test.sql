-- Synthetic RPC regression based on the reported immutable-type mismatch.
-- These fixtures are not copies of the user's device operations or cloud rows.
begin;
select plan(14);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000221', 'metric-type-sync-guard@example.test');
insert into public.app_settings (id, user_id, timezone, timezone_configured)
values ('general', '00000000-0000-4000-8000-000000000221', 'UTC', true)
on conflict (user_id) do update set timezone = 'UTC', timezone_configured = true;

create function pg_temp.mern_definition(p_schema integer, p_type text)
returns jsonb language plpgsql immutable as $$
declare
  v_rule jsonb;
  v_definition jsonb;
begin
  v_rule := case when p_schema = 8
    then '{"kind":"comparison","metricId":"hours","operator":"at-least","value":1}'::jsonb
    else '{"kind":"comparison","metricId":"hours","operator":"greater-than","value":0}'::jsonb end;
  v_definition := jsonb_build_object(
    'schemaVersion', p_schema, 'id', '00000000-0000-4000-8000-000000000421',
    'kind', 'challenge', 'status', 'active', 'name', 'Synthetic MERN v' || p_schema,
    'startDate', '2026-10-17', 'deadline', '2026-11-16',
    'metrics', jsonb_build_array(jsonb_build_object('id','hours','name','Hours','valueType',p_type,'unit','Hours')),
    'schedule', '{"kind":"every-day"}'::jsonb, 'scheduling', '{"mode":"calendar"}'::jsonb,
    'qualificationRule', v_rule, 'strictMode', false,
    'streakRuleMode', 'custom', 'streakRule', v_rule
  );
  if p_schema = 10 then
    v_definition := v_definition || jsonb_build_object('ruleVersions', jsonb_build_array(jsonb_build_object(
      'id','latest','effectiveFrom','2026-10-17','revision',2,'application','recalculate-all-history','recordedAt','2026-10-17T00:00:00Z',
      'evaluation',jsonb_build_object(
        'startDate','2026-10-17','deadline','2026-11-16','schedule','{"kind":"every-day"}'::jsonb,
        'scheduling','{"mode":"calendar"}'::jsonb,
        'metrics',jsonb_build_array(jsonb_build_object('id','hours','name','Hours','valueType',p_type,'unit','Hours')),
        'qualificationRule',v_rule,'strictMode',false,'streakRuleMode','custom','streakRule',v_rule
      )
    )));
  end if;
  return v_definition;
end;
$$;

create function pg_temp.mern_record(p_schema integer, p_type text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000421','schema_version',p_schema,
    'kind','challenge','status','active','name','Synthetic MERN v' || p_schema,
    'definition',pg_temp.mern_definition(p_schema,p_type)
  )
$$;

create function pg_temp.cp_record(p_type text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id','00000000-0000-4000-8000-000000000422','schema_version',8,
    'kind','challenge','status','active','name','Synthetic CP v8',
    'definition',jsonb_build_object(
      'schemaVersion',8,'id','00000000-0000-4000-8000-000000000422',
      'kind','challenge','status','active','name','Synthetic CP v8',
      'startDate','2026-10-17','deadline','2026-11-16',
      'metrics',jsonb_build_array(
        jsonb_build_object('id','hours','name','Hours','valueType',p_type,'unit','Hours'),
        jsonb_build_object('id','done','name','Done','valueType','boolean')
      ),
      'schedule','{"kind":"every-day"}'::jsonb,
      'qualificationRule','{"kind":"comparison","metricId":"done","operator":"equals","value":true}'::jsonb,
      'strictMode',false,'streakRuleMode','custom',
      'streakRule','{"kind":"any","operands":[{"kind":"comparison","metricId":"hours","operator":"greater-than","value":0},{"kind":"comparison","metricId":"done","operator":"equals","value":true}]}'::jsonb
    )
  )
$$;

-- MERN-like cloud state starts at v6/revision 1 with the stable Hours ID and
-- quantity type. CP-like cloud state starts at v8/revision 3.
insert into public.trackers (id, user_id, schema_version, kind, status, name, definition)
values ('00000000-0000-4000-8000-000000000421','00000000-0000-4000-8000-000000000221',6,'challenge','active','Synthetic MERN v6',
  '{"schemaVersion":6,"id":"00000000-0000-4000-8000-000000000421","kind":"challenge","status":"active","name":"Synthetic MERN v6","startDate":"2026-10-17","deadline":"2026-11-16","metrics":[{"id":"hours","name":"Hours","valueType":"quantity","unit":"Hours"}],"schedule":{"kind":"every-day"},"scheduling":{"mode":"calendar"}}'),
 ('00000000-0000-4000-8000-000000000422','00000000-0000-4000-8000-000000000221',8,'challenge','active','Synthetic CP v8',
  '{"schemaVersion":8,"id":"00000000-0000-4000-8000-000000000422","kind":"challenge","status":"active","name":"Synthetic CP v8","startDate":"2026-10-17","deadline":"2026-11-16","metrics":[{"id":"hours","name":"Hours","valueType":"quantity","unit":"Hours"},{"id":"done","name":"Done","valueType":"boolean"}],"schedule":{"kind":"every-day"},"qualificationRule":{"kind":"comparison","metricId":"done","operator":"equals","value":true},"strictMode":false,"streakRuleMode":"custom","streakRule":{"kind":"any","operands":[{"kind":"comparison","metricId":"hours","operator":"greater-than","value":0},{"kind":"comparison","metricId":"done","operator":"equals","value":true}]}}');
update public.trackers set name = 'Synthetic CP v8 revision 2' where id = '00000000-0000-4000-8000-000000000422';
update public.trackers set name = 'Synthetic CP v8 revision 3' where id = '00000000-0000-4000-8000-000000000422';
insert into public.tracker_entries (id, user_id, tracker_id, entry_date, outcome, entry_values)
values
 ('00000000-0000-4000-8000-000000000431','00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000421',current_date,'recorded','{"hours":1.5}'),
 ('00000000-0000-4000-8000-000000000432','00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000422',current_date,'recorded','{"hours":2.25,"done":true}');

select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000421'),1::bigint,'MERN-like cloud revision is one');
select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000422'),3::bigint,'CP-like cloud revision is three');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000221';
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000441','tracker',1,pg_temp.mern_record(8,'duration'))$$,
  '23514','Saved measure types cannot be changed. Add a new measure to record values differently.','MERN-like v8 quantity-to-duration write is rejected');
select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000421'),1::bigint,'rejected MERN v8 write leaves revision one unchanged');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000442','tracker',1,pg_temp.mern_record(10,'duration'))$$,
  '23514','Saved measure types cannot be changed. Add a new measure to record values differently.','MERN-like v10 quantity-to-duration write is rejected');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000443','tracker',1,pg_temp.mern_record(10,'quantity')))->>'status',
  'applied','corrected MERN v10 current definition and history snapshot apply through the real RPC');
select results_eq($$select schema_version,server_revision,definition->'metrics'->0->>'id',definition->'metrics'->0->>'valueType',definition->'ruleVersions'->0->>'revision',definition->'ruleVersions'->0->>'application' from public.trackers where id='00000000-0000-4000-8000-000000000421'$$,
  $$values (10::smallint,2::bigint,'hours'::text,'quantity'::text,'2'::text,'recalculate-all-history'::text)$$,
  'corrected MERN v10 preserves measure identity and the one-entry revision-2 history');
select is((select entry_values->>'hours' from public.tracker_entries where id='00000000-0000-4000-8000-000000000431'),'1.5'::text,'corrected MERN payload preserves the saved numeric value');
select throws_ok($$select public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000444','tracker',3,pg_temp.cp_record('duration'))$$,
  '23514','Saved measure types cannot be changed. Add a new measure to record values differently.','CP-like v8 quantity-to-duration write is rejected');
select is((select server_revision from public.trackers where id='00000000-0000-4000-8000-000000000422'),3::bigint,'rejected CP v8 write leaves revision three unchanged');
select is((public.apply_tracker_sync_operation('00000000-0000-4000-8000-000000000221','00000000-0000-4000-8000-000000000445','tracker',3,pg_temp.cp_record('quantity')))->>'status',
  'applied','corrected CP v8 payload applies through the real RPC at revision three');
select results_eq($$select server_revision,definition->'metrics'->0->>'id',definition->'metrics'->0->>'valueType',definition->>'streakRuleMode',definition->'streakRule'->>'kind' from public.trackers where id='00000000-0000-4000-8000-000000000422'$$,
  $$values (4::bigint,'hours'::text,'quantity'::text,'custom'::text,'any'::text)$$,
  'corrected CP v8 preserves measure ID and its any-of custom streak rule');
select is((select entry_values->>'hours' from public.tracker_entries where id='00000000-0000-4000-8000-000000000432'),'2.25'::text,'corrected CP payload preserves the saved numeric value');

reset role;
select ok(exists(select 1 from pg_trigger t where t.tgrelid='public.trackers'::regclass and t.tgname='tracker_metric_integrity_guard'
  and not t.tgisinternal and t.tgfoid='public.guard_tracker_metric_integrity()'::regprocedure and (t.tgtype & 2)=2 and (t.tgtype & 16)=16),
  'the rejecting function is installed as a BEFORE UPDATE trigger');
select * from finish();
rollback;
