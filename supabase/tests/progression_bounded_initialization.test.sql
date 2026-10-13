begin;
select plan(10);

select has_function('public','initialize_progression_accounts_batch',array['integer'],'bounded progression initialization batch exists');
select ok(not has_function_privilege('authenticated','public.initialize_progression_accounts_batch(integer)','execute'), 'browser users cannot run account initialization batches');
select ok(not has_function_privilege('service_role','public.initialize_progression_accounts_batch(integer)','execute'), 'API service role cannot run account initialization batches');
select ok(has_function_privilege('authenticated','public.get_progression_legacy_xp_status()','execute'), 'signed-in users can read their own historical XP state');
select ok(not has_function_privilege('anon','public.get_progression_legacy_xp_status()','execute'), 'anonymous users cannot read progression state');
select ok(position('server_changed_at < v_initialized_at' in pg_get_functiondef('public.initialize_progression_account(uuid)'::regprocedure)) > 0,
  'opening estimate excludes rows first changed at or after the account cutover');
select ok(position('v_historic and v_state.current_xp = 0' in pg_get_functiondef('public.record_progression_entry_award(uuid,uuid,uuid,date,jsonb,text,timestamptz)'::regprocedure)) > 0,
  'late historical edits do not create new per-entry XP awards');

insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000808','bounded-init@example.test');
delete from public.progression_achievement_progress where user_id='00000000-0000-4000-8000-000000000808';
delete from public.progression_achievement_accounts where user_id='00000000-0000-4000-8000-000000000808';
delete from public.progression_events where user_id='00000000-0000-4000-8000-000000000808';
delete from public.progression_account_state where user_id='00000000-0000-4000-8000-000000000808';

select is((select processed_accounts from public.initialize_progression_accounts_batch(1)),1,'batch processes one missing account when asked for one');
select is((select remaining_accounts from public.initialize_progression_accounts_batch(1)),0::bigint,'batch reports no accounts after the last account is initialized');
select is((select count(*) from public.progression_account_state where user_id='00000000-0000-4000-8000-000000000808'),1::bigint,'resumed batch creates exactly one account state row');
select * from finish();
rollback;
