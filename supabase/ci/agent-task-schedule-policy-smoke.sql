-- SCH-1: immutable per-occurrence policy and recorded overlap skip/defer.
-- Uses a transaction-local synthetic account; never runs an agent or sends messages.
begin;
do $$
declare
 v_user uuid := '00000000-0000-4000-8000-000000000190';
 v_agent uuid := gen_random_uuid();
 v_account uuid;
 v_skip uuid;
 v_defer uuid;
 v_result jsonb;
 v_claim jsonb;
 v_first text;
 v_seen_skip boolean := false;
 v_seen_defer boolean := false;
 v_firing uuid;
begin
 insert into auth.users(id,email,raw_user_meta_data)
 values(v_user,'agent-task-snapshot-smoke@example.test',
 '{"full_name":"Agent Task Frozen Policy Smoke"}'::jsonb);
 select account_id into strict v_account from public.profiles where user_id=v_user;
 insert into public.ai_agents(id,account_id,slug,name,purpose,status)
 values(v_agent,v_account,'trigger-policy-smoke','Trigger Policy Smoke','custom','active');

 v_skip:=public.create_agent_task_trigger(
  v_account,'services.promotion',1,v_agent,'schedule','once',
  now()-interval '5 minutes',null,null,null,'{"serviceId":"frozen"}'::jsonb,
  '{}'::jsonb,'trigger-policy-skip-187',v_user);
 v_defer:=public.create_agent_task_trigger(
  v_account,'services.promotion',1,v_agent,'schedule','once',
  now()-interval '4 minutes',null,null,null,'{"serviceId":"defer"}'::jsonb,
  '{}'::jsonb,'trigger-policy-defer-187',v_user);
 update public.ai_agent_task_triggers
 set overlap_policy='defer',policy_version=2
 where id=v_defer;

 v_result:=public.materialize_agent_task_trigger_firings(now(),20);
 if (v_result->>'schedule_firings')::integer<>2 then
  raise exception 'SCH187_MATERIALIZE_MISMATCH: %',v_result;
 end if;
 if not exists(
   select 1 from public.ai_agent_task_trigger_firings
   where trigger_id=v_defer and policy_snapshot->>'overlap_policy'='defer'
   and policy_snapshot->>'policy_version'='2'
 ) then raise exception 'SCH187_POLICY_NOT_FROZEN'; end if;

 update public.ai_agent_task_triggers
 set config='{"serviceId":"changed"}'::jsonb,overlap_policy='skip',
     policy_version=3
 where id=v_defer;

 for i in 1..2 loop
  v_claim:=public.claim_next_agent_task_trigger_firing('sch187-worker',120);
  if v_claim is null then raise exception 'SCH187_CLAIM_MISSING'; end if;
  v_firing:=(v_claim->>'firing_id')::uuid;
  if (v_claim->>'trigger_id')::uuid=v_defer then
    if v_claim->>'overlap_policy'<>'defer'
       or v_claim->>'policy_version'<>'2'
       or v_claim->'config'->>'serviceId'<>'defer' then
      raise exception 'SCH187_CLAIM_USED_MUTATED_POLICY: %',v_claim;
    end if;
    if not public.defer_agent_task_trigger_firing(
     v_firing,v_claim->>'claim_owner','OVERLAP_REUSED_ACTIVE_TASK',300
    ) then raise exception 'SCH187_DEFER_FAILED'; end if;
    v_seen_defer:=true;
  else
    if not public.skip_agent_task_trigger_firing(
      v_firing,v_claim->>'claim_owner','SERVICE_PROMOTION_ALREADY_ACTIVE'
    ) then raise exception 'SCH187_SKIP_FAILED'; end if;
    v_seen_skip:=true;
  end if;
 end loop;
 if not v_seen_skip or not v_seen_defer then
  raise exception 'SCH187_REQUIRED_OUTCOMES_NOT_SEEN';
 end if;
 if not exists(
   select 1 from public.ai_agent_task_trigger_firings where trigger_id=v_skip
   and status='skipped' and skip_reason='SERVICE_PROMOTION_ALREADY_ACTIVE'
 ) then raise exception 'SCH187_SKIP_NOT_DURABLE'; end if;
 if not exists(
   select 1 from public.ai_agent_task_trigger_firings where trigger_id=v_defer
   and status='pending' and attempts=0 and available_at>now()
   and last_error='OVERLAP_REUSED_ACTIVE_TASK'
 ) then raise exception 'SCH187_DEFER_NOT_DURABLE'; end if;

 begin
  update public.ai_agent_task_trigger_firings
    set policy_snapshot='{}'::jsonb
  where trigger_id=v_skip;
  raise exception 'SCH187_SNAPSHOT_REWRITE_ACCEPTED';
 exception when others then
  if sqlerrm<>'AGENT_TASK_FIRING_POLICY_IMMUTABLE' then raise; end if;
 end;

 if has_function_privilege('authenticated',
    'public.skip_agent_task_trigger_firing(uuid,text,text)','EXECUTE')
    or has_function_privilege('authenticated',
    'public.defer_agent_task_trigger_firing(uuid,text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated',
    'public.create_reviewed_agent_task_trigger(uuid,text,integer,uuid,text,text,timestamptz,integer,text,integer,jsonb,jsonb,text,uuid,uuid,text)','EXECUTE')
 then raise exception 'SCH187_SERVICE_ONLY_RPC_EXPOSED'; end if;

 raise notice 'SCH187 frozen policy skip/defer smoke passed';
end $$;
rollback;
