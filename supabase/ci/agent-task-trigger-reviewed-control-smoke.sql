-- SCH-2: account-scoped REVIEWED control denies unapproved and cross-tenant enable.
begin;
do $$
declare
 v_user uuid := '00000000-0000-4000-8000-000000000191';
 v_account uuid;
 v_agent uuid := gen_random_uuid();
 v_trigger uuid;
begin
 insert into auth.users(id,email,raw_user_meta_data)
 values (v_user,'sch2-control-smoke@example.test',
  '{"full_name":"SCH2 Control Smoke"}'::jsonb);
 select account_id into strict v_account from public.profiles where user_id=v_user;
 -- New auth.users fixtures are not privileged by default; set a reviewed
 -- admin role only within this rolled-back smoke transaction.
 update public.profiles set account_role='owner' where user_id=v_user;
 if not found then raise exception 'SCH2_OWNER_FIXTURE_NOT_CREATED'; end if;
 insert into public.ai_agents(id,account_id,slug,name,purpose,status)
 values (v_agent,v_account,'sch2-control-smoke','SCH2 Control Smoke','custom','active');
 v_trigger:=public.create_agent_task_trigger(
  v_account,'coverage.sourcing',2,v_agent,'schedule','once',
  now()+interval '1 day',null,null,null,
  jsonb_build_object('coverageRequestId',gen_random_uuid()),'{}'::jsonb,
  'sch2-reviewed-control-188',v_user
 );
 -- An ordinary agent must fail closed, even with the correct account ID.
 update public.profiles set account_role='agent' where user_id=v_user;
 begin
  perform public.set_reviewed_agent_task_trigger_status(
   v_account,v_trigger,'paused',v_user
  );
  raise exception 'SCH2_AGENT_CONTROL_ALLOWED';
 exception when others then
  if sqlerrm <> 'AGENT_TASK_TRIGGER_CONTROL_UNAUTHORIZED' then raise; end if;
 end;
 update public.profiles set account_role='owner' where user_id=v_user;
 if not public.set_reviewed_agent_task_trigger_status(
  v_account,v_trigger,'paused',v_user
 ) then raise exception 'SCH2_PAUSE_REJECTED'; end if;
 if public.set_reviewed_agent_task_trigger_status(
  gen_random_uuid(),v_trigger,'paused',v_user
 ) then raise exception 'SCH2_FOREIGN_TENANT_MUTATION'; end if;
 begin
  perform public.set_reviewed_agent_task_trigger_status(
   v_account,v_trigger,'enabled',v_user
  );
  raise exception 'SCH2_UNREVIEWED_ENABLE_ALLOWED';
 exception when others then
  if sqlerrm <> 'AGENT_TASK_TRIGGER_REVIEW_REVISION_CHANGED' then raise; end if;
 end;
 if has_function_privilege('authenticated',
  'public.set_reviewed_agent_task_trigger_status(uuid,uuid,text,uuid)','EXECUTE'
 ) then raise exception 'SCH2_PRIVATE_CONTROL_EXPOSED'; end if;
 raise notice 'SCH2 reviewed tenant control smoke passed';
end $$;
rollback;
