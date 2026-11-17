-- SCH-2: policy update/cancel is immutable-history and no-send.
begin;
do $$
declare
 v_user uuid := '00000000-0000-4000-8000-000000000192';
 v_account uuid;
 v_agent uuid:=gen_random_uuid();
 v_trigger uuid;
 v_result jsonb;
 v_claim jsonb;
 v_firing uuid;
 v_blocked uuid;
begin
 insert into auth.users(id,email,raw_user_meta_data)
 values(v_user,'schedule-edit-cancel@example.test',
 '{"full_name":"Schedule Edit Cancel Smoke"}'::jsonb);
 select account_id into strict v_account from public.profiles where user_id=v_user;
 update public.profiles set account_role='owner' where user_id=v_user;
 insert into public.ai_agents(id,account_id,slug,name,purpose,status)
 values(v_agent,v_account,'schedule-edit-smoke','Schedule Edit Smoke','custom','active');
 v_trigger:=public.create_agent_task_trigger(
 v_account,'coverage.sourcing',2,v_agent,'schedule','recurring',
 now()+interval '1 day',60,null,null,
 jsonb_build_object('coverageRequestId',gen_random_uuid()),'{}'::jsonb,
 'schedule-edit-cancel-unique-189',v_user);
 update public.ai_agent_task_triggers
  set approved_revision_id=gen_random_uuid(),approved_by=v_user
 where id=v_trigger;

 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 values(v_account,v_trigger,'schedule',
 'schedule:189-claimed',now()-interval '1 minute',now()-interval '1 minute');
 v_claim:=public.claim_next_agent_task_trigger_firing('sch189-worker',120);
 if v_claim is null or (v_claim->>'trigger_id')::uuid<>v_trigger then
  raise exception 'SCH189_CLAIM_SETUP_FAILED: %',v_claim;
 end if;
 perform public.set_agent_task_trigger_status(v_account,v_trigger,'paused');
 v_result:=public.update_reviewed_agent_task_trigger_policy(
 v_account,v_trigger,v_user,1,'recurring',now()+interval '2 days',120,'defer');
 if v_result->>'reason'<>'CLAIM_IN_FLIGHT' then
  raise exception 'SCH189_EDIT_RACED_ACTIVE_CLAIM: %',v_result;
 end if;
 v_result:=public.cancel_reviewed_agent_task_trigger(v_account,v_trigger,v_user,1);
 if v_result->>'reason'<>'CLAIM_IN_FLIGHT' then
  raise exception 'SCH189_CANCEL_RACED_ACTIVE_CLAIM: %',v_result;
 end if;
 if not public.complete_agent_task_trigger_firing(
   (v_claim->>'firing_id')::uuid,v_claim->>'claim_owner',null) then
  raise exception 'SCH189_CLAIM_SETTLEMENT_FAILED';
 end if;
 perform public.set_agent_task_trigger_status(v_account,v_trigger,'enabled');
 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 values(v_account,v_trigger,'schedule',
 'schedule:189-pending-before-edit',now()-interval '2 minutes',now())
 returning id into v_firing;
 perform public.set_agent_task_trigger_status(v_account,v_trigger,'paused');
 v_result:=public.update_reviewed_agent_task_trigger_policy(
 v_account,v_trigger,v_user,1,'recurring',now()+interval '2 days',120,'defer');
 if v_result->>'updated'<>'true'
    or (v_result->>'policy_version')::integer<>2
    or (v_result->>'skipped_firings')::integer<>1 then
  raise exception 'SCH189_EDIT_FAILED: %',v_result;
 end if;
 if not exists(select 1 from public.ai_agent_task_trigger_firings
  where id=v_firing and status='skipped'
    and skip_reason='SCHEDULE_POLICY_REPLACED'
    and policy_snapshot->>'policy_version'='1') then
  raise exception 'SCH189_EDIT_DID_NOT_PRESERVE_FROZEN_HISTORY';
 end if;
 v_result:=public.update_reviewed_agent_task_trigger_policy(
 v_account,v_trigger,v_user,1,'once',now()+interval '3 days',null,'skip');
 if v_result->>'reason'<>'STALE_POLICY_VERSION' then
  raise exception 'SCH189_STALE_VERSION_ACCEPTED: %',v_result;
 end if;
 begin
  perform public.update_reviewed_agent_task_trigger_policy(
   gen_random_uuid(),v_trigger,v_user,2,'once',now()+interval '3 days',null,'skip');
  raise exception 'SCH189_FOREIGN_ACCOUNT_ACCEPTED';
 exception when others then
  if sqlerrm<>'AGENT_TASK_TRIGGER_EDIT_UNAUTHORIZED' then raise; end if;
 end;
 update public.profiles set account_role='agent' where user_id=v_user;
 begin
  perform public.cancel_reviewed_agent_task_trigger(v_account,v_trigger,v_user,2);
  raise exception 'SCH189_AGENT_CANCEL_ACCEPTED';
 exception when others then
  if sqlerrm<>'AGENT_TASK_TRIGGER_CANCEL_UNAUTHORIZED' then raise; end if;
 end;
 update public.profiles set account_role='owner' where user_id=v_user;
 perform public.set_agent_task_trigger_status(v_account,v_trigger,'enabled');
 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 values(v_account,v_trigger,'schedule',
 'schedule:189-pending-before-cancel',now()-interval '3 minutes',now())
 returning id into v_blocked;
 perform public.set_agent_task_trigger_status(v_account,v_trigger,'paused');
 v_result:=public.cancel_reviewed_agent_task_trigger(v_account,v_trigger,v_user,2);
 if v_result->>'cancelled'<>'true' or
    (v_result->>'skipped_firings')::integer<>1 then
  raise exception 'SCH189_CANCEL_FAILED: %',v_result;
 end if;
 if not exists(select 1 from public.ai_agent_task_trigger_firings
  where id=v_blocked and status='skipped'
  and skip_reason='SCHEDULE_POLICY_CANCELLED') then
  raise exception 'SCH189_CANCEL_DID_NOT_FLUSH_BACKLOG';
 end if;
 if public.set_agent_task_trigger_status(v_account,v_trigger,'enabled')
 or public.set_reviewed_agent_task_trigger_status(v_account,v_trigger,'enabled',v_user)
 then raise exception 'SCH189_CANCELLED_POLICY_REVIVED'; end if;
 v_blocked:=null;
 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 values(v_account,v_trigger,'schedule',
 'schedule:189-ghost-after-cancel',now(),now()) returning id into v_blocked;
 if v_blocked is not null then
  raise exception 'SCH189_POST_CANCEL_FIRING_INSERTED';
 end if;
 v_result:=public.cancel_reviewed_agent_task_trigger(v_account,v_trigger,v_user,2);
 if v_result->>'already_cancelled'<>'true' then
  raise exception 'SCH189_IDEMPOTENT_CANCEL_FAILED';
 end if;
 if has_function_privilege('authenticated',
  'public.update_reviewed_agent_task_trigger_policy(uuid,uuid,uuid,integer,text,timestamptz,integer,text)','EXECUTE')
 or has_function_privilege('authenticated',
  'public.cancel_reviewed_agent_task_trigger(uuid,uuid,uuid,integer)','EXECUTE') then
  raise exception 'SCH189_RPC_GRANTS_EXPOSED';
 end if;
 raise notice 'SCH189 pause/version/claim/tenant/cancel/no-revival checks passed';
end $$;
rollback;
