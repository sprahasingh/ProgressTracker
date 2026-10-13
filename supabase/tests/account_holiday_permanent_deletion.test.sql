begin;
select plan(40);

select has_table('public','account_holiday_deletion_ledger','holiday deletion ledger exists');
select is((select relrowsecurity from pg_class where oid='public.account_holiday_deletion_ledger'::regclass),true,'holiday deletion ledger has RLS enabled');
select ok(has_table_privilege('authenticated','public.account_holiday_deletion_ledger','select'),'authenticated can read the owner-filtered holiday ledger');
select ok(not has_table_privilege('authenticated','public.account_holiday_deletion_ledger','insert'),'clients cannot forge holiday ledger entries');
select ok(not has_function_privilege('anon','public.permanently_delete_account_holiday(uuid,uuid,uuid,bigint)','execute'),'anonymous users cannot delete holidays');
select ok(has_function_privilege('authenticated','public.permanently_delete_account_holiday(uuid,uuid,uuid,bigint)','execute'),'authenticated users can call the owner-checked holiday RPC');
select ok(not has_function_privilege('authenticated','public.purge_expired_account_holiday_bin()','execute'),'authenticated users cannot run holiday cleanup');
select is((select enabled from public.account_holiday_cleanup_control where id),false,'holiday cleanup is disabled by default');
select ok(exists(select 1 from cron.job where jobname='progress-tracker-holiday-cleanup' and active and schedule='0 3 * * *' and command='select public.purge_expired_account_holiday_bin();'),'one inert daily holiday cleanup job is installed');

insert into auth.users (id,email) values
 ('00000000-0000-4000-8000-000000003101','holiday-delete-one@example.test'),
 ('00000000-0000-4000-8000-000000003102','holiday-delete-two@example.test');

set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003101';
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003201',null,
 '{"id":"00000000-0000-4000-8000-000000003301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}'
))->>'status','applied'::text,'account owner creates a holiday');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003202',1,
 '{"id":"00000000-0000-4000-8000-000000003301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":"2000-01-01T00:00:00Z"}'
))->>'status','applied'::text,'server applies soft deletion using its own timestamp');
select ok((select deleted_at > clock_timestamp() - interval '1 minute' from public.account_holidays where id='00000000-0000-4000-8000-000000003301'),'client cannot backdate the 30-day retention timestamp');
select is((public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003203','00000000-0000-4000-8000-000000003301',2
))->>'status','deleted'::text,'owner permanently deletes the tombstoned holiday');
select is((public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003204','00000000-0000-4000-8000-000000003301',2
))->>'status','already_deleted'::text,'duplicate deletion requests are idempotent');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003201',null,
 '{"id":"00000000-0000-4000-8000-000000003301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}'
))->>'status','permanently_deleted'::text,'ledger check blocks stale idempotency receipt replay');
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003209',null,
 '{"id":"00000000-0000-4000-8000-000000003301","holiday_date":"2026-12-24","reason":"travel","created_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}'
))->>'status','permanently_deleted'::text,'a stale restore from a new operation is blocked by the deletion ledger');
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003301'),0::bigint,'permanently deleted holiday row is removed');
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003301'),1::bigint,'permanent deletion ledger is retained');
select throws_ok($$select public.permanently_delete_account_holiday('00000000-0000-4000-8000-000000003102','00000000-0000-4000-8000-000000003205','00000000-0000-4000-8000-000000003301',2)$$,'42501','authenticated owner does not match holiday workspace','RPC rejects a mismatched account identity');
reset role;

insert into public.account_holidays(id,user_id,holiday_date,deleted_at) values
 ('00000000-0000-4000-8000-000000003303','00000000-0000-4000-8000-000000003101','2026-12-26',clock_timestamp()-interval '1 day');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003102';
select is((public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003102','00000000-0000-4000-8000-000000003207','00000000-0000-4000-8000-000000003303',1
))->>'status','not_found'::text,'another account cannot permanently delete a holiday it does not own');
reset role;
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003303'),1::bigint,'cross-account request leaves the owner’s holiday untouched');

insert into public.account_holidays(id,user_id,holiday_date)
values ('00000000-0000-4000-8000-000000003305','00000000-0000-4000-8000-000000003101','2026-12-28');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003101';
select is((public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003210','00000000-0000-4000-8000-000000003305',1
))->>'status','conflict'::text,'active holidays cannot be permanently deleted');
reset role;
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003305'),1::bigint,'active holiday remains after rejected deletion');
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003305'),0::bigint,'rejected active deletion creates no ledger entry');

insert into public.account_holidays(id,user_id,holiday_date,deleted_at)
values ('00000000-0000-4000-8000-000000003306','00000000-0000-4000-8000-000000003101','2026-12-29',clock_timestamp()-interval '1 day');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003101';
select is((public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003211','00000000-0000-4000-8000-000000003306',0
))->>'status','conflict'::text,'stale server revisions are rejected');
reset role;
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003306'),1::bigint,'stale revision leaves the deleted holiday unchanged');
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003306'),0::bigint,'stale revision creates no deletion ledger entry');

-- Force a failure after finalization has begun. The function call's subtransaction
-- must roll back the ledger and receipt writes along with the holiday deletion.
insert into public.account_holidays(id,user_id,holiday_date,deleted_at)
values ('00000000-0000-4000-8000-000000003307','00000000-0000-4000-8000-000000003101','2026-12-30',clock_timestamp()-interval '1 day');
create or replace function public.test_reject_account_holiday_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'injected holiday delete failure';
end;
$$;
create trigger test_reject_account_holiday_delete
before delete on public.account_holidays
for each row execute function public.test_reject_account_holiday_delete();
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003101';
select throws_ok($$select public.permanently_delete_account_holiday(
 '00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000003212','00000000-0000-4000-8000-000000003307',1
)$$,'P0001','injected holiday delete failure','a failed finalization reports the underlying database error');
reset role;
drop trigger test_reject_account_holiday_delete on public.account_holidays;
drop function public.test_reject_account_holiday_delete();
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003307'),1::bigint,'failed finalization preserves the holiday row');
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003307'),0::bigint,'failed finalization rolls back its ledger entry');
select is((select count(*) from public.private_account_holiday_deletion_receipts where operation_id='00000000-0000-4000-8000-000000003212'),0::bigint,'failed finalization rolls back its idempotency receipt');

insert into public.account_holidays(id,user_id,holiday_date,deleted_at) values
 ('00000000-0000-4000-8000-000000003304','00000000-0000-4000-8000-000000003102','2026-12-27',clock_timestamp()-interval '31 days');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000003102';
select is((public.apply_account_holiday_sync_operation(
 '00000000-0000-4000-8000-000000003102','00000000-0000-4000-8000-000000003208',1,
 '{"id":"00000000-0000-4000-8000-000000003304","holiday_date":"2026-12-27","reason":null,"deleted_at":null}'
))->>'status','permanently_deleted'::text,'a stale restore after the 30-day window is finalized instead');
reset role;
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003304'),1::bigint,'stale restore creates a permanent deletion ledger record');

insert into public.account_holidays(id,user_id,holiday_date,deleted_at) values
 ('00000000-0000-4000-8000-000000003302','00000000-0000-4000-8000-000000003102','2026-12-25',clock_timestamp()-interval '31 days');
insert into public.account_holidays(id,user_id,holiday_date,deleted_at) values
 ('00000000-0000-4000-8000-000000003308','00000000-0000-4000-8000-000000003102','2026-12-31',clock_timestamp()-interval '29 days');
select is(public.purge_expired_account_holiday_bin(),0,'cleanup does nothing while its separate switch is off');
select is((select count(*) from public.account_holidays where id in ('00000000-0000-4000-8000-000000003302','00000000-0000-4000-8000-000000003308')),2::bigint,'expired and recent holidays remain while cleanup is disabled');
update public.account_holiday_cleanup_control set enabled=true where id=true;
select is(public.purge_expired_account_holiday_bin(),1,'cleanup removes an item after 30 days');
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003308'),1::bigint,'cleanup preserves a holiday deleted less than 30 days ago');
select is((select count(*) from public.account_holiday_deletion_ledger where holiday_id='00000000-0000-4000-8000-000000003302'),1::bigint,'scheduled cleanup retains a stale-restore ledger');
select is(public.purge_expired_account_holiday_bin(),0,'repeated cleanup is idempotent');
select is((select count(*) from public.account_holidays where id='00000000-0000-4000-8000-000000003302'),0::bigint,'expired holiday data remains absent after retry');

select * from finish();
rollback;
