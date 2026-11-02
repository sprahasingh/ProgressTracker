begin;
select plan(35);

select ok(to_regclass('public.progression_perfect_day_repair_queue') is not null,
  'durable owner/date repair queue exists');
select ok((select relrowsecurity from pg_class where oid='public.progression_perfect_day_repair_queue'::regclass),
  'repair queue has row-level security enabled');
select ok(not has_table_privilege('authenticated','public.progression_perfect_day_repair_queue','select'),
  'authenticated clients cannot inspect repair queue rows');
select ok(exists(select 1 from pg_indexes where schemaname='public'
  and indexname='progression_perfect_day_repair_ready_idx'),
  'ready work is indexed for bounded queue selection');
select ok(exists(
  select 1 from pg_index i
  join pg_class x on x.oid=i.indexrelid
  join pg_class t on t.oid=i.indrelid
  join pg_namespace n on n.oid=t.relnamespace
  where n.nspname='public' and t.relname='tracker_entries'
    and x.relname='tracker_entries_user_id_tracker_id_entry_date_key'
    and i.indisunique and i.indisvalid and i.indisready
    and pg_get_indexdef(i.indexrelid) =
      'CREATE UNIQUE INDEX tracker_entries_user_id_tracker_id_entry_date_key ON public.tracker_entries USING btree (user_id, tracker_id, entry_date)'),
  'tracker history staging uses the existing valid owner/tracker/date unique index');
select ok(exists(
  select 1 from pg_index i
  join pg_class x on x.oid=i.indexrelid
  join pg_class t on t.oid=i.indrelid
  join pg_namespace n on n.oid=t.relnamespace
  where n.nspname='public' and t.relname='tracker_entries'
    and x.relname='tracker_entries_pkey'
    and i.indisunique and i.indisvalid and i.indisready
    and pg_get_indexdef(i.indexrelid) =
      'CREATE UNIQUE INDEX tracker_entries_pkey ON public.tracker_entries USING btree (id)')
  and not exists(select 1 from pg_class where relname in
    ('tracker_entries_user_tracker_date_idx','tracker_entries_user_id_idx')),
  'global UUID keyset backfill uses the existing primary key without duplicate indexes');
select ok(exists(select 1 from pg_constraint where conrelid='public.progression_perfect_day_repair_queue'::regclass
  and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (user_id, entry_date)'),
  'queue key makes each owner/date idempotent');
select ok((select count(*)=0 from pg_catalog.pg_constraint
  where conrelid in ('public.progression_perfect_day_repair_queue'::regclass,
                     'public.progression_perfect_day_tracker_jobs'::regclass)
    and contype='f')
  and exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass
    and tgname='zzz_progression_perfect_day_queue_cleanup_after_owner_delete' and not tgisinternal),
  'owner cleanup runs after cascades without queue foreign-key races');
select ok(to_regclass('public.progression_perfect_day_backfill_state') is not null,
  'resumable backfill cursor persists across worker restarts');
select ok(position('least(coalesce(p_limit,500),500)' in lower(pg_get_functiondef(
  'public.enqueue_perfect_day_backfill_batch(integer)'::regprocedure)))>0
  and position('order by e.id limit v_limit' in lower(pg_get_functiondef(
    'public.enqueue_perfect_day_backfill_batch(integer)'::regprocedure)))>0,
  'backfill inspects at most 500 rows per indexed UUID-keyset call');
select ok(has_function_privilege('authenticated','public.reconcile_perfect_day_repair_batch(integer)','execute') is false,
  'clients cannot invoke internal reconciliation worker');
select ok(has_function_privilege('authenticated','public.enqueue_perfect_day_backfill_batch(integer)','execute') is false,
  'clients cannot advance internal backfill cursor');
select ok(has_function_privilege('authenticated','public.enqueue_perfect_day_tracker_job_batch(integer)','execute') is false,
  'clients cannot enumerate tracker repair jobs');
select ok(exists(select 1 from pg_trigger where tgrelid='public.tracker_entries'::regclass
  and tgname='tracker_entries_perfect_day_repair_queue' and not tgisinternal),
  'check-in mutations enqueue their exact affected date');
select ok(exists(select 1 from pg_trigger where tgrelid='public.trackers'::regclass
  and tgname='trackers_perfect_day_repair_queue' and not tgisinternal),
  'tracker rule and schedule mutations enqueue bounded tracker work');
select ok(exists(select 1 from pg_trigger where tgrelid='public.account_holidays'::regclass
  and tgname='account_holidays_perfect_day_repair_queue' and not tgisinternal)
  and exists(select 1 from pg_trigger where tgrelid='public.tracker_holidays'::regclass
  and tgname='tracker_holidays_perfect_day_repair_queue' and not tgisinternal),
  'account and tracker holiday dates enqueue their exact affected date');
select ok(exists(select 1 from pg_trigger where tgrelid='public.app_settings'::regclass
  and tgname='app_settings_enqueue_perfect_day_timezone' and not tgisinternal),
  'timezone changes enqueue both old and new local current dates');
select ok(position('description' in pg_get_functiondef('public.queue_perfect_day_tracker_change()'::regprocedure))>0,
  'tracker display-only edits are filtered from repair jobs');
select ok(position('reconcile_missing_perfect_days' in pg_get_functiondef(
  'public.refresh_my_progression_qualification_progress()'::regprocedure))=0,
  'authenticated refresh no longer scans historical dates');
select ok(position('initialize_progression_account(' in pg_get_functiondef(
  'public.refresh_my_progression_qualification_progress()'::regprocedure))=0
  and position('reconcile_progression_achievements(' in pg_get_functiondef(
    'public.refresh_my_progression_qualification_progress()'::regprocedure))=0,
  'refresh only reads saved progress and never invokes account/history reconciliation');
select ok(position('progression_local_date' in pg_get_functiondef(
  'public.refresh_my_progression_qualification_progress()'::regprocedure))>0,
  'pending status excludes future dates until they become locally eligible');
select ok(position('progression_perfect_day_backfill_state' in pg_get_functiondef(
  'public.refresh_my_progression_qualification_progress()'::regprocedure))>0
  and position('progression_perfect_day_tracker_jobs' in pg_get_functiondef(
    'public.refresh_my_progression_qualification_progress()'::regprocedure))>0,
  'pending status includes a user with an unfinished backfill or tracker job');
select ok(position('count(*)' in lower(pg_get_functiondef(
  'public.refresh_my_progression_qualification_progress()'::regprocedure)))=0,
  'refresh tests pending work with indexed existence checks instead of counting a full backlog');
select ok(position('78120426000100' in pg_get_functiondef(
  'public.reconcile_perfect_day_repair_batch(integer)'::regprocedure))>0,
  'historical and current-day workers share one overlap lock');
select ok(position('for update of q skip locked' in lower(pg_get_functiondef(
  'public.reconcile_perfect_day_repair_batch(integer)'::regprocedure)))>0,
  'date queue claims work without blocking another worker');
select ok(position('next_attempt_at=clock_timestamp()+least' in lower(pg_get_functiondef(
  'public.reconcile_perfect_day_repair_batch(integer)'::regprocedure)))>0,
  'date failures receive bounded exponential retry scheduling');
select ok(position('order by next_attempt_at,queued_at,user_id,tracker_id' in lower(pg_get_functiondef(
  'public.enqueue_perfect_day_tracker_job_batch(integer)'::regprocedure)))>0,
  'tracker staging jobs rotate by next retry and queue time for fairness');

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000009301','repair-failure@example.test'),
 ('00000000-0000-4000-8000-000000009302','repair-recovery@example.test');
insert into public.app_settings(id,user_id,timezone,timezone_configured) values
 ('general','00000000-0000-4000-8000-000000009301','UTC',true),
 ('general','00000000-0000-4000-8000-000000009302','UTC',true);
insert into public.progression_perfect_day_repair_queue(user_id,entry_date,queued_at,next_attempt_at) values
 ('00000000-0000-4000-8000-000000009301',current_date-1,clock_timestamp(),clock_timestamp()),
 ('00000000-0000-4000-8000-000000009302',current_date-1,clock_timestamp(),clock_timestamp());

-- Inject a deterministic failure for one synthetic date. All function
-- replacements are transaction-scoped and are restored by this file's rollback.
create or replace function public.progression_evaluate_perfect_day(p_user_id uuid,p_date date)
returns text language plpgsql set search_path = '' as $$
begin
  if p_user_id='00000000-0000-4000-8000-000000009301'::uuid then
    raise exception 'synthetic date failure' using errcode='22012';
  end if;
  return 'unsupported';
end;
$$;
create or replace function public.reconcile_progression_perfect_day(p_user_id uuid,p_date date)
returns void language plpgsql set search_path = '' as $$ begin return; end; $$;
create or replace function public.reconcile_progression_achievements(p_user_id uuid)
returns void language plpgsql set search_path = '' as $$ begin return; end; $$;

select is(public.reconcile_perfect_day_repair_batch(2),1,
  'a failing date is isolated while the next owner/date in the same batch completes');
select is((select attempts from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009301'),1,
  'failed date remains queued with one retry attempt');
select is((select last_sqlstate from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009301'),'22012'::text,
  'failure diagnostics persist only the SQLSTATE');
select is((select count(*)::integer from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009302'),0,
  'successful neighboring date is removed from the queue');
select is((select count(*)::integer from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009301'),1,
  'failure backoff does not discard the failed date');

create or replace function public.progression_evaluate_perfect_day(p_user_id uuid,p_date date)
returns text language sql set search_path = '' as $$ select 'unsupported'::text $$;
update public.progression_perfect_day_repair_queue set next_attempt_at=clock_timestamp()
where user_id='00000000-0000-4000-8000-000000009301';
select is(public.reconcile_perfect_day_repair_batch(2),1,
  'a failed date recovers on a later retry after its dependency is repaired');
select is((select count(*)::integer from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009301'),0,
  'recovered date is removed only after reconciliation completes');

insert into public.progression_perfect_day_repair_queue(user_id,entry_date)
values ('00000000-0000-4000-8000-000000009301',current_date-1);
insert into public.progression_perfect_day_tracker_jobs(user_id,tracker_id)
values ('00000000-0000-4000-8000-000000009301','00000000-0000-4000-8000-000000009399');
delete from auth.users where id='00000000-0000-4000-8000-000000009301';
select is((select count(*)::integer from public.progression_perfect_day_repair_queue
  where user_id='00000000-0000-4000-8000-000000009301')
  +(select count(*)::integer from public.progression_perfect_day_tracker_jobs
  where user_id='00000000-0000-4000-8000-000000009301'),0,
  'deleting an owner removes their queued dates and tracker jobs');

select * from finish();
rollback;
