-- SCH-5: fifth-attempt crash recovery, lease fencing, no blind retry.
begin;
do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000200';
  v_agent uuid := gen_random_uuid();
  v_account uuid;
  v_trigger uuid;
  v_early uuid;
  v_exhausted uuid;
  v_live uuid;
  v_old jsonb;
  v_next jsonb;
begin
  if exists(select 1 from auth.users where id=v_user) then
    raise exception 'SCH5_REAPER_FIXTURE_COLLISION';
  end if;
  insert into auth.users(id,email,raw_user_meta_data)
    values(v_user,'sch5-expired-lease@example.test','{"full_name":"SCH5 Lease"}'::jsonb);
  select account_id into strict v_account from public.profiles where user_id=v_user;
  insert into public.ai_agents(id,account_id,slug,name,purpose,status)
    values(v_agent,v_account,'sch5-lease','SCH5 Lease','custom','active');
  v_trigger:=public.create_agent_task_trigger(
    v_account,'coverage.sourcing',1,v_agent,'schedule','recurring',
    now()+interval '1 day',60,null,null,
    jsonb_build_object('coverageRequestId',gen_random_uuid()),'{}'::jsonb,
    'sch5-final-claim-reaper-regression',v_user
  );
  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,
    available_at,status,attempts,claimed_by,lease_expires_at
  ) values (
    v_account,v_trigger,'schedule','schedule:sch5-attempt-4',
    now()-interval '2 minutes',now()-interval '2 minutes',
    'claimed',4,'sch5-original-owner',
    now()-interval '1 second'
  ) returning id into v_early;

  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,
    available_at,status,attempts,claimed_by,lease_expires_at
  ) values (
    v_account,v_trigger,'schedule','schedule:sch5-attempt-5-expired',
    now()-interval '2 minutes',now()-interval '2 minutes',
    'claimed',5,'sch5-dead-owner',
    now()-interval '1 second'
  ) returning id into v_exhausted;

  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,
    available_at,status,attempts,claimed_by,lease_expires_at
  ) values (
    v_account,v_trigger,'schedule','schedule:sch5-attempt-5-active',
    now()-interval '2 minutes',now()-interval '2 minutes',
    'claimed',5,'sch5-active-owner',
    now()+interval '1 minute'
  ) returning id into v_live;

  if public.reap_expired_agent_task_trigger_firings(20)<>1 then
    raise exception 'SCH5_REAPER_COUNT_INCORRECT';
  end if;
  if not exists (
    select 1 from public.ai_agent_task_trigger_firings
    where id=v_exhausted and status='dead'
      and attempts=5 and lease_expires_at is null and claimed_by is null
      and last_error='AGENT_TASK_TRIGGER_LEASE_RETRIES_EXHAUSTED'
  ) then
    raise exception 'SCH5_EXPIRED_FIFTH_ATTEMPT_NOT_TERMINAL';
  end if;
  if not exists(select 1 from public.ai_agent_task_trigger_firings
      where id=v_live and status='claimed' and claimed_by='sch5-active-owner')
    or not exists(select 1 from public.ai_agent_task_trigger_firings
      where id=v_early and status='claimed' and attempts=4) then
    raise exception 'SCH5_VALID_OR_RETRYABLE_CLAIM_CHANGED';
  end if;

  v_next := public.claim_next_agent_task_trigger_firing('sch5-recovered',120);
  if v_next is null or (v_next->>'firing_id')::uuid<>v_early
    or (v_next->>'attempts')::integer<>5 then
    raise exception 'SCH5_FOURTH_LEASE_NOT_RECOVERABLE: %',v_next;
  end if;
  if public.complete_agent_task_trigger_firing(v_early,'sch5-original-owner',null) then
    raise exception 'SCH5_OLD_LEASE_COMPLETED_AFTER_RECLAIM';
  end if;
  if public.reap_expired_agent_task_trigger_firings(20)<>0 then
    raise exception 'SCH5_REAPER_TOUCHED_ACTIVE_CLAIM';
  end if;
  update public.ai_agent_task_trigger_firings
     set lease_expires_at=now()-interval '1 second'
  where id=v_early;
  if public.reap_expired_agent_task_trigger_firings(20)<>1 then
    raise exception 'SCH5_RECLAIMED_FIFTH_LEASE_NOT_TERMINAL';
  end if;
  if public.complete_agent_task_trigger_firing(
      v_early,v_next->>'claim_owner',null) then
    raise exception 'SCH5_EXPIRED_FIFTH_OWNER_COMPLETED';
  end if;
  if has_function_privilege('authenticated',
      'public.reap_expired_agent_task_trigger_firings(integer)','EXECUTE') then
    raise exception 'SCH5_REAPER_PUBLIC_EXECUTE';
  end if;
  raise notice 'PASS SCH5 bounded fifth-lease reaper, stale owner rejected, active owner untouched, account/Task preserved';
end;
$$;
rollback;
