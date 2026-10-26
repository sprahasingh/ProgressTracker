begin;
set local statement_timeout = '60s';
select plan(14);

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000003981','archive-worker@example.test');
select public.initialize_progression_account('00000000-0000-4000-8000-000000003981');
insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition)
values ('00000000-0000-4000-8000-000000003982','00000000-0000-4000-8000-000000003981',1,'habit','active','Worker retry',now(),
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000003982','kind','habit','status','active','name','Worker retry',
    'createdAt',now()::text,'startDate',(current_date-2)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true)));
insert into public.trackers(id,user_id,schema_version,kind,status,name,created_at,definition)
values ('00000000-0000-4000-8000-000000003984','00000000-0000-4000-8000-000000003981',1,'habit','active','Independent worker',now(),
  jsonb_build_object('schemaVersion',1,'id','00000000-0000-4000-8000-000000003984','kind','habit','status','active','name','Independent worker',
    'createdAt',now()::text,'startDate',(current_date-2)::text,'schedule',jsonb_build_object('kind','every-day'),
    'metrics',jsonb_build_array(jsonb_build_object('id','done','name','Done','valueType','boolean')),
    'qualificationRule',jsonb_build_object('kind','comparison','metricId','done','operator','equals','value',true)));
insert into public.tracker_entries(id,user_id,tracker_id,entry_date,outcome,entry_values)
values ('00000000-0000-4000-8000-000000003983','00000000-0000-4000-8000-000000003981','00000000-0000-4000-8000-000000003982',current_date-1,'recorded','{"done":true}');
insert into public.private_progression_archive_reconciliation_jobs(user_id,tracker_id,from_date,through_date)
values ('00000000-0000-4000-8000-000000003981','00000000-0000-4000-8000-000000003982',current_date-1,current_date-1);
insert into public.private_progression_archive_reconciliation_jobs(user_id,tracker_id,from_date,through_date,phase,date_cursor)
values ('00000000-0000-4000-8000-000000003981','00000000-0000-4000-8000-000000003984',current_date-1,current_date-1,'dates',current_date-2);

savepoint worker_interruption;
select public.process_progression_archive_reconciliation_batch(20);
rollback to savepoint worker_interruption;
select ok((select phase='entries' and entry_after_date is null from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),
  'transaction interruption rolls the work item back to its last committed cursor');
select ok(pg_catalog.strpos(pg_catalog.lower(pg_get_functiondef('public.process_progression_archive_reconciliation_batch(integer)'::regprocedure)), 'for update skip locked') > 0,
  'worker claims use SKIP LOCKED so concurrent workers do not claim the same row');

create temporary table saved_worker_function(definition text);
insert into saved_worker_function select pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamp with time zone)'::regprocedure);
create or replace function public.record_progression_entry_award(
  p_user_id uuid,p_tracker_id uuid,p_entry_id uuid,p_entry_date date,p_values jsonb,p_outcome text,p_deleted_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
begin raise exception 'injected transient worker failure' using errcode='P0001'; end;
$$;

select is(public.process_progression_archive_reconciliation_batch(20)->>'failures','1',
  'worker reports a failed work item instead of aborting silently');
select is((select failure_count from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),1,
  'failed item remains durable with an incremented retry count');
select ok((select last_error like 'P0001:%injected transient worker failure%' and last_failed_at is not null
  from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),
  'failure details remain observable for operations');
select ok((select entry_after_date is null and phase='entries' from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),
  'failed work does not advance the durable cursor');
select is((select count(*) from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003984'),0::bigint,
  'a failed work item does not prevent independent queue items from completing');

do $$ begin
  execute (select definition from saved_worker_function);
  update public.private_progression_archive_reconciliation_jobs set retry_after=clock_timestamp()-interval '1 second'
  where tracker_id='00000000-0000-4000-8000-000000003982';
end $$;
select is(public.process_progression_archive_reconciliation_batch(20)->>'remaining','0',
  'restoring the dependency and retrying converges from the saved cursor');
select is(public.process_progression_archive_reconciliation_batch(20)->>'processed','0',
  'repeated processing after convergence is an idempotent no-op');
select public.queue_progression_archive_reconciliation('00000000-0000-4000-8000-000000003981','00000000-0000-4000-8000-000000003982',current_date-1,current_date-1);
select is((select failure_count from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),0,
  'newly queued archive work clears stale failure state');
select is((select retry_after <= clock_timestamp() and entry_after_date is null and phase='entries'
  from public.private_progression_archive_reconciliation_jobs where tracker_id='00000000-0000-4000-8000-000000003982'),true,
  'requeued work restarts immediately from its durable first cursor');
update public.private_progression_archive_reconciliation_jobs
set from_date=current_date-400,through_date=current_date-1,phase='dates',date_cursor=current_date-401,
    retry_after=clock_timestamp(),entry_after_date=null,entry_after_id=null
where tracker_id='00000000-0000-4000-8000-000000003982';
select is(public.process_progression_archive_reconciliation_batch(200)->>'dates','200',
  'a large historical date backlog stays within the configured batch bound');
select is(public.process_progression_archive_reconciliation_batch(200)->>'dates','200',
  'a second bounded batch completes the remaining historical dates');
select is(public.process_progression_archive_reconciliation_batch(200)->>'remaining','0',
  'the final bounded reconciliation phase converges after the date backlog');

select * from finish();
rollback;
