begin;
set local statement_timeout = '60s';
select plan(5);

select ok(to_regclass('public.private_progression_archive_backfill_control') is not null,
  'archive inventory stores its resume cursor outside the migration transaction');
select ok(to_regclass('public.trackers_archived_reconciliation_scan_idx') is not null,
  'archive inventory has a partial index for archived tracker slices');

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','archive-bounded-backfill@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured)
values('general','00000000-0000-4000-8000-000000000001','UTC',true);
select public.initialize_progression_account('00000000-0000-4000-8000-000000000001');
update public.progression_account_state set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000000001';
update public.progression_achievement_accounts set initialized_at=(current_date-10)::timestamptz
where user_id='00000000-0000-4000-8000-000000000001';

insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition) values
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',1,'habit','archived','Archived one',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000011','kind','habit','status','archived','name','Archived one',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'archivedAt',(current_date-2)::text||'T00:00:00Z',
    'schedule',jsonb_build_object('kind','every-day'),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true))),
 ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001',1,'habit','archived','Archived two',current_date-10,
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000000012','kind','habit','status','archived','name','Archived two',
    'createdAt',(current_date-10)::text||'T00:00:00Z','startDate',(current_date-10)::text,'archivedAt',(current_date-2)::text||'T00:00:00Z',
    'schedule',jsonb_build_object('kind','every-day'),'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true)));

-- Reopen the inventory cursor inside this rollback-only fixture so the test is
-- deterministic even if the local cron worker already completed its scan.
update public.private_progression_archive_backfill_control
set last_user_id=null,last_tracker_id=null,complete=false,updated_at=clock_timestamp()
where singleton;
select is(public.enqueue_progression_archive_reconciliation_batch(1)->>'processed','1',
  'inventory enqueues at most the requested one tracker in a pass');
select is(public.enqueue_progression_archive_reconciliation_batch(1)->>'remaining','false',
  'the resumed inventory batch reaches completion after its last tracker');
select is((select count(*) from public.private_progression_archive_reconciliation_jobs
  where user_id='00000000-0000-4000-8000-000000000001'),2::bigint,
  'bounded inventory records both archived trackers without reconciling them inline');

select * from finish();
rollback;
