-- SOF-89.08: durable effect stage evidence, conservative recovery and causal
-- route fences. No automated replay of possibly dispatched external effects.
CREATE FUNCTION public.inbox_validate_canonical_route(p_account uuid,p_conversation uuid,p_message uuid,p_connection uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.inbox_message_memberships im
 JOIN public.inbox_canonical_messages cm ON cm.id::text=im.evidence_ref AND cm.account_id=im.account_id AND cm.source_message_id=im.message_id AND cm.direction='inbound'
 JOIN public.whatsapp_channel_memberships ep ON ep.id=im.membership_id AND ep.account_id=im.account_id AND ep.connection_id=im.connection_id AND ep.channel_id=im.channel_id
 JOIN public.whatsapp_connections wc ON wc.id=ep.connection_id AND wc.account_id=ep.account_id AND wc.provider=ep.provider
 JOIN public.inbox_native_namespace_proofs np ON np.membership_id=ep.id AND np.account_id=ep.account_id AND np.channel_id=ep.channel_id
 WHERE im.account_id=p_account AND im.conversation_id=p_conversation AND im.message_id=p_message AND im.connection_id=p_connection
 AND im.evidence_kind='verified_current_ingress' AND ep.valid_until IS NULL AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
 AND wc.session_id IS NOT DISTINCT FROM ep.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM ep.instance_snapshot
 AND cm.origin_membership_id=ep.id AND cm.namespace_key=np.namespace_key)
$$;
REVOKE ALL ON FUNCTION public.inbox_validate_canonical_route(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_validate_canonical_route(uuid,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.inbox_task_route_conflict(p_account uuid,p_conversation uuid,p_connection uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.ai_agent_task_targets target JOIN public.ai_agent_tasks task ON task.id=target.task_id AND task.account_id=target.account_id
 LEFT JOIN public.messages outbound ON outbound.id=target.last_outbound_message_id AND outbound.conversation_id=p_conversation
 WHERE target.account_id=p_account AND target.conversation_id=p_conversation AND task.status='running'
 AND target.status IN ('queued','preparing','contacted','awaiting_reply','replied','in_progress') AND target.last_outbound_message_id IS NOT NULL
 AND (outbound.id IS NULL OR outbound.provider IS DISTINCT FROM 'openwa' OR outbound.connection_id IS DISTINCT FROM p_connection
 OR (task.target_policy ? 'whatsappConnectionId' AND task.target_policy->>'whatsappConnectionId' IS DISTINCT FROM p_connection::text)))
$$;
REVOKE ALL ON FUNCTION public.inbox_task_route_conflict(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_task_route_conflict(uuid,uuid,uuid) TO service_role;

create or replace function public.correlate_agent_task_inbound_reply(
  p_account_id uuid,
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_reply_to_message_id uuid,
  p_has_human_assignee boolean default false
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_conversation public.conversations%rowtype;
  v_existing_run public.ai_agent_runs%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target_ids uuid[];
  v_candidate_count integer := 0;
  v_correlation_method text := null;
  v_agent_status text;
  v_revision_status text;
  v_provider_connection_id uuid;
  v_run_id uuid;
  v_idempotency_key text;
  v_paused integer := 0;
  v_canonical_route uuid;
begin
  perform 1
  from public.messages as message
  where message.id=p_inbound_message_id
    and message.conversation_id=p_conversation_id
    and message.sender_type='customer'
  for update;

  if not found then
    raise exception 'AGENT_TASK_REPLY_INBOUND_CONTEXT_MISMATCH';
  end if;

  select *
    into v_conversation
  from public.conversations
  where id=p_conversation_id
    and account_id=p_account_id
  for update;

  if v_conversation.id is null then
    raise exception 'AGENT_TASK_REPLY_CONVERSATION_MISMATCH';
  end if;

  select im.connection_id into v_canonical_route from public.inbox_message_memberships im
    where im.account_id=p_account_id and im.conversation_id=p_conversation_id and im.message_id=p_inbound_message_id and im.evidence_kind='verified_current_ingress';
  if v_canonical_route is not null and (
    not public.inbox_validate_canonical_route(p_account_id,p_conversation_id,p_inbound_message_id,v_canonical_route)
    or public.inbox_task_route_conflict(p_account_id,p_conversation_id,v_canonical_route)
    or (p_reply_to_message_id is not null and not exists(select 1 from public.messages m where m.id=p_reply_to_message_id and m.conversation_id=p_conversation_id and m.provider='openwa' and m.connection_id=v_canonical_route))
  ) then
    return jsonb_build_object('status','ambiguous','reason','canonical_route_conflict');
  end if;

  if coalesce(p_has_human_assignee,false)
     or v_conversation.assigned_agent_id is not null then
    v_paused:=public.pause_agent_task_targets_for_human(
      p_account_id,
      p_conversation_id,
      coalesce(v_conversation.assigned_agent_id::text,'inbound-human'),
      'inbound_reply_human_takeover'
    );

    return jsonb_build_object(
      'status','human_paused',
      'reason','human_takeover',
      'paused_targets',v_paused
    );
  end if;

  select *
    into v_existing_run
  from public.ai_agent_runs
  where inbound_message_id=p_inbound_message_id
  limit 1;

  if v_existing_run.id is not null then
    if v_existing_run.trigger_type='task_reply'
       and v_existing_run.task_id is not null
       and v_existing_run.task_target_id is not null then
      select *
        into v_target
      from public.ai_agent_task_targets
      where id=v_existing_run.task_target_id
        and account_id=v_existing_run.account_id
        and task_id=v_existing_run.task_id;

      return jsonb_build_object(
        'status','matched',
        'reason','existing',
        'run_id',v_existing_run.id,
        'task_id',v_existing_run.task_id,
        'task_target_id',v_existing_run.task_target_id,
        'agent_id',v_existing_run.ai_agent_id,
        'agent_revision_id',v_existing_run.agent_revision_id,
        'provider_connection_id',v_existing_run.provider_connection_id,
        'counterparty_role',coalesce(v_existing_run.counterparty_role,v_target.counterparty_role),
        'correlation_method',coalesce(v_existing_run.trigger_ref,'existing')
      );
    end if;

    return jsonb_build_object(
      'status','inbound_already_routed',
      'reason','existing_non_task_run',
      'run_id',v_existing_run.id
    );
  end if;

  if p_reply_to_message_id is not null then
    select
      count(distinct target.id),
      array_agg(distinct target.id order by target.id)
      into v_candidate_count, v_target_ids
    from public.ai_agent_task_targets as target
    join public.ai_agent_tasks as task
      on task.account_id=target.account_id
     and task.id=target.task_id
    where target.account_id=p_account_id
      and target.conversation_id=p_conversation_id
      and task.status='running'
      and target.status in (
        'queued',
        'preparing',
        'contacted',
        'awaiting_reply',
        'replied',
        'in_progress'
      )
      and target.last_outbound_message_id is not null
      and (
        target.last_outbound_message_id=p_reply_to_message_id
        or exists (
          select 1
          from public.ai_agent_task_outbound_messages as outbound
          where outbound.account_id=target.account_id
            and outbound.task_id=target.task_id
            and outbound.task_target_id=target.id
            and outbound.local_message_id=p_reply_to_message_id
            and outbound.status='sent'
        )
        or exists (
          select 1
          from public.ai_agent_runs as prior_reply
          where prior_reply.account_id=target.account_id
            and prior_reply.task_id=target.task_id
            and prior_reply.task_target_id=target.id
            and prior_reply.trigger_type='task_reply'
            and prior_reply.status='succeeded'
            and prior_reply.outbound_message_id=p_reply_to_message_id
        )
      );

    if v_candidate_count=1 then
      v_correlation_method:='reply_context';
    end if;
  end if;

  if v_candidate_count=0 then
    select
      count(distinct target.id),
      array_agg(distinct target.id order by target.id)
      into v_candidate_count, v_target_ids
    from public.ai_agent_task_targets as target
    join public.ai_agent_tasks as task
      on task.account_id=target.account_id
     and task.id=target.task_id
    where target.account_id=p_account_id
      and target.conversation_id=p_conversation_id
      and task.status='running'
      and target.status in (
        'queued',
        'preparing',
        'contacted',
        'awaiting_reply',
        'replied',
        'in_progress'
      )
      and target.last_outbound_message_id is not null;

    if v_candidate_count=1 then
      v_correlation_method:='single_active_target';
    end if;
  end if;

  if v_candidate_count=0 or v_target_ids is null then
    return jsonb_build_object(
      'status','no_match',
      'reason','no_active_task_target'
    );
  end if;

  if v_candidate_count>1 then
    return jsonb_build_object(
      'status','ambiguous',
      'reason','multiple_active_task_targets',
      'candidate_count',v_candidate_count
    );
  end if;

  select *
    into v_target
  from public.ai_agent_task_targets
  where id=v_target_ids[1]
    and account_id=p_account_id
  for update;

  select *
    into v_task
  from public.ai_agent_tasks
  where id=v_target.task_id
    and account_id=p_account_id
    and status='running'
  for update;

  if v_task.id is null then
    return jsonb_build_object(
      'status','no_match',
      'reason','task_not_running'
    );
  end if;

  if v_canonical_route is not null and (
    not exists(select 1 from public.messages m where m.id=v_target.last_outbound_message_id and m.conversation_id=p_conversation_id and m.provider='openwa' and m.connection_id=v_canonical_route)
    or (v_task.target_policy ? 'whatsappConnectionId' and v_task.target_policy->>'whatsappConnectionId' is distinct from v_canonical_route::text)
  ) then
    return jsonb_build_object('status','ambiguous','reason','canonical_route_conflict');
  end if;

  update public.ai_agent_task_targets
     set status='replied',
         replied_at=coalesce(replied_at,now()),
         next_action_at=null,
         available_at=now(),
         claimed_by=null,
         lease_expires_at=null,
         failure_code=null
   where id=v_target.id;

  select
    agent.status,
    revision.status,
    revision.provider_connection_id
    into v_agent_status, v_revision_status, v_provider_connection_id
  from public.ai_agents as agent
  join public.ai_agent_revisions as revision
    on revision.account_id=agent.account_id
   and revision.agent_id=agent.id
  where agent.account_id=p_account_id
    and agent.id=v_task.agent_id
    and revision.id=v_task.agent_revision_id;

  if v_agent_status is distinct from 'active'
     or v_revision_status not in ('published','superseded')
     or v_provider_connection_id is null then
    perform public.append_agent_task_event(
      p_account_id,
      v_task.id,
      v_target.id,
      null,
      'target.replied',
      'service',
      'reply-correlation',
      jsonb_build_object(
        'inbound_message_id',p_inbound_message_id,
        'reply_to_message_id',p_reply_to_message_id,
        'correlation_method',v_correlation_method,
        'routable',false
      )
    );

    return jsonb_build_object(
      'status','correlated_unroutable',
      'reason','task_agent_not_routable',
      'task_id',v_task.id,
      'task_target_id',v_target.id,
      'correlation_method',v_correlation_method
    );
  end if;

  v_idempotency_key:=
    'task-reply:'||p_inbound_message_id::text||
    ':target:'||v_target.id::text||
    ':revision:'||v_task.agent_revision_id::text;

  insert into public.ai_agent_runs (
    account_id,
    conversation_id,
    inbound_message_id,
    ai_agent_id,
    agent_revision_id,
    provider_connection_id,
    route_id,
    route_reason,
    plane,
    status,
    idempotency_key,
    run_mode,
    task_id,
    task_target_id,
    trigger_type,
    trigger_ref,
    counterparty_role
  ) values (
    p_account_id,
    p_conversation_id,
    p_inbound_message_id,
    v_task.agent_id,
    v_task.agent_revision_id,
    v_provider_connection_id,
    null,
    'task_reply:'||v_correlation_method,
    'customer',
    'queued',
    v_idempotency_key,
    'inbound',
    v_task.id,
    v_target.id,
    'task_reply',
    v_correlation_method,
    v_target.counterparty_role
  )
  on conflict (inbound_message_id) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id
      into v_run_id
    from public.ai_agent_runs
    where inbound_message_id=p_inbound_message_id;
  end if;

  perform public.append_agent_task_event(
    p_account_id,
    v_task.id,
    v_target.id,
    v_run_id,
    'target.replied',
    'service',
    'reply-correlation',
    jsonb_build_object(
      'inbound_message_id',p_inbound_message_id,
      'reply_to_message_id',p_reply_to_message_id,
      'correlation_method',v_correlation_method,
      'routable',true
    )
  );

  return jsonb_build_object(
    'status','matched',
    'reason','matched',
    'run_id',v_run_id,
    'task_id',v_task.id,
    'task_target_id',v_target.id,
    'agent_id',v_task.agent_id,
    'agent_revision_id',v_task.agent_revision_id,
    'provider_connection_id',v_provider_connection_id,
    'counterparty_role',v_target.counterparty_role,
    'correlation_method',v_correlation_method
  );
end;
$$;
REVOKE ALL ON FUNCTION public.correlate_agent_task_inbound_reply(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correlate_agent_task_inbound_reply(uuid,uuid,uuid,uuid,boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.inbox_claim_canonical_effect(p_account uuid,p_canonical uuid,p_connection uuid,p_event text,p_receipt_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE tok uuid; c public.inbox_canonical_messages%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=p_canonical AND origin_connection_id=p_connection AND direction='inbound' FOR UPDATE;
 IF NOT FOUND OR c.source_message_id IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts r JOIN public.inbox_message_connection_observations o ON o.receipt_id=r.id AND o.account_id=r.account_id
 JOIN public.whatsapp_channel_memberships ep ON ep.id=o.membership_id AND ep.account_id=o.account_id AND ep.channel_id=o.channel_id AND ep.connection_id=o.connection_id
 JOIN public.whatsapp_connections wc ON wc.id=o.connection_id AND wc.account_id=o.account_id AND wc.provider=o.provider
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_receipt_token,c.native_message_id) AND o.canonical_id=p_canonical
 AND ep.id=c.origin_membership_id AND ep.valid_until IS NULL AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
 AND wc.session_id IS NOT DISTINCT FROM ep.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM ep.instance_snapshot) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE account_id=p_account AND message_id=c.source_message_id AND evidence_kind='verified_current_ingress' AND evidence_ref=c.id::text) THEN RETURN NULL; END IF;
 -- Current legacy Task correlation selects candidates by CRM parent rather
 -- than WhatsApp route. Until the dedicated exact-causal routing policy is
 -- activated, conservatively hold instead of mutating a foreign reservation.
 IF public.inbox_task_route_conflict(p_account,c.conversation_id,c.origin_connection_id) THEN
  UPDATE public.inbox_canonical_effects SET state='review' WHERE account_id=p_account AND canonical_id=p_canonical AND state='pending';
  RETURN NULL;
 END IF;
 UPDATE public.inbox_canonical_effects SET state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
 WHERE account_id=p_account AND canonical_id=p_canonical AND state='pending' RETURNING claim_token INTO tok;
 RETURN tok;
END $$;
REVOKE ALL ON FUNCTION public.inbox_claim_canonical_effect(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;




CREATE OR REPLACE FUNCTION wacrm_internal.inbox_effect_no_reclaim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF (OLD.state='claimed' AND NEW.state NOT IN ('claimed','returned','review')) OR
    (OLD.state IN ('returned','review','not_applicable') AND NEW.state<>OLD.state) OR
    (OLD.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token) OR
    (OLD.payload_digest IS NOT NULL AND NEW.payload_digest IS DISTINCT FROM OLD.payload_digest) OR
    (OLD.dispatch_context IS NOT NULL AND NEW.dispatch_context IS DISTINCT FROM OLD.dispatch_context)
 THEN RAISE EXCEPTION 'INBOX_EFFECT_IMMUTABLE_CLAIM' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_effect_no_reclaim() FROM PUBLIC,anon,authenticated,service_role;


CREATE TABLE public.inbox_canonical_effect_stages (
 account_id uuid NOT NULL,provider text NOT NULL,channel_id uuid NOT NULL,canonical_id uuid NOT NULL,
 stage_key text NOT NULL CHECK(stage_key IN ('conversation_created','reopen','broadcast_reply','admin_command','admin_reply','task_correlation','agent_dispatch','flows','legacy_ai','message_received','automation:new_contact_created','automation:first_inbound_message','automation:new_message_received','automation:keyword_match','automation:interactive_reply')),
 claim_token uuid NOT NULL,state text NOT NULL CHECK(state IN ('started','returned','review')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 PRIMARY KEY(canonical_id,stage_key),
 FOREIGN KEY(account_id,provider,channel_id,canonical_id) REFERENCES public.inbox_canonical_messages(account_id,provider,channel_id,id) ON DELETE CASCADE
);
ALTER TABLE public.inbox_canonical_effect_stages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_canonical_effect_stages FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE(state,finished_at) ON public.inbox_canonical_effect_stages TO service_role;
CREATE POLICY inbox_service_only ON public.inbox_canonical_effect_stages FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_effect_stage_account_idx ON public.inbox_canonical_effect_stages(account_id,state,started_at);
CREATE FUNCTION wacrm_internal.inbox_effect_stage_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.state<>'started' OR NEW.state NOT IN ('returned','review') OR NEW.finished_at IS NULL THEN RAISE EXCEPTION 'INBOX_STAGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_effect_stage_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_effect_stage_guard BEFORE UPDATE ON public.inbox_canonical_effect_stages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_effect_stage_guard();

CREATE FUNCTION public.inbox_begin_canonical_stage(p_account uuid,p_canonical uuid,p_claim uuid,p_stage text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE e public.inbox_canonical_effects%ROWTYPE;c public.inbox_canonical_messages%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=p_canonical AND direction='inbound' FOR UPDATE;
 IF NOT FOUND OR NOT public.inbox_validate_canonical_route(p_account,c.conversation_id,c.source_message_id,c.origin_connection_id) THEN RETURN false; END IF;
 SELECT * INTO e FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=p_canonical AND claim_token=p_claim AND state='claimed' FOR UPDATE;
 IF NOT FOUND OR e.claimed_at<clock_timestamp()-interval '15 minutes' THEN RETURN false; END IF;
 INSERT INTO public.inbox_canonical_effect_stages(account_id,provider,channel_id,canonical_id,stage_key,claim_token,state)
 VALUES(p_account,c.provider,c.channel_id,c.id,p_stage,p_claim,'started') ON CONFLICT(canonical_id,stage_key) DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.inbox_begin_canonical_stage(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_begin_canonical_stage(uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.inbox_finish_canonical_stage(p_account uuid,p_canonical uuid,p_claim uuid,p_stage text,p_returned boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=p_canonical AND claim_token=p_claim AND state='claimed' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.inbox_canonical_effect_stages SET state=CASE WHEN p_returned THEN 'returned' ELSE 'review' END,finished_at=clock_timestamp()
 WHERE account_id=p_account AND canonical_id=p_canonical AND claim_token=p_claim AND stage_key=p_stage AND state='started';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.inbox_finish_canonical_stage(uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_finish_canonical_stage(uuid,uuid,uuid,text,boolean) TO service_role;
CREATE OR REPLACE FUNCTION public.inbox_finish_canonical_effect(p_account uuid,p_canonical uuid,p_claim uuid,p_returned boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.inbox_canonical_effects e SET state=CASE WHEN p_returned AND NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages x WHERE x.account_id=p_account AND x.canonical_id=p_canonical AND x.state<>'returned') THEN 'returned' ELSE 'review' END,
 returned_at=clock_timestamp() WHERE e.account_id=p_account AND e.canonical_id=p_canonical AND e.claim_token=p_claim AND e.state='claimed';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.inbox_finish_canonical_effect(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.inbox_recover_stale_canonical_effects(p_limit integer DEFAULT 20)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE e record;n integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'INBOX_RECOVERY_LIMIT' USING ERRCODE='22023'; END IF;
 FOR e IN SELECT account_id,canonical_id FROM public.inbox_canonical_effects WHERE state='claimed' AND claimed_at<clock_timestamp()-interval '15 minutes' ORDER BY claimed_at LIMIT p_limit FOR UPDATE SKIP LOCKED
 LOOP
  UPDATE public.inbox_canonical_effect_stages SET state='review',finished_at=clock_timestamp() WHERE account_id=e.account_id AND canonical_id=e.canonical_id AND state='started';
  UPDATE public.inbox_canonical_effects SET state='review',returned_at=clock_timestamp() WHERE account_id=e.account_id AND canonical_id=e.canonical_id AND state='claimed';
  n=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.inbox_recover_stale_canonical_effects(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_recover_stale_canonical_effects(integer) TO service_role;
CREATE INDEX inbox_stale_claims_idx ON public.inbox_canonical_effects(claimed_at,canonical_id) WHERE state='claimed';

-- A queued agent must use the original proven route, not a later inbound
-- in the same CRM parent. Distinct unrelated business targets stay explicit.
CREATE FUNCTION public.inbox_canonical_agent_run_route(p_account uuid,p_conversation uuid,p_run uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE im public.inbox_message_memberships%ROWTYPE;
BEGIN
 SELECT i.* INTO im FROM public.ai_agent_runs r JOIN public.inbox_message_memberships i ON i.message_id=r.inbound_message_id AND i.account_id=r.account_id
 WHERE r.id=p_run AND r.account_id=p_account AND r.conversation_id=p_conversation AND i.conversation_id=p_conversation AND i.evidence_kind='verified_current_ingress';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT public.inbox_validate_canonical_route(p_account,p_conversation,im.message_id,im.connection_id) THEN RAISE EXCEPTION 'INBOX_CAUSAL_ROUTE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 RETURN im.connection_id;
END $$;
REVOKE ALL ON FUNCTION public.inbox_canonical_agent_run_route(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_canonical_agent_run_route(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.inbox_correlate_broadcast_reply(p_account uuid,p_canonical uuid,p_claim uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE cm public.inbox_canonical_messages%ROWTYPE;cid uuid;ts timestamptz;start_at timestamptz;quoted_native text;ids uuid[];
BEGIN
 SELECT * INTO cm FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=p_canonical AND direction='inbound' FOR UPDATE;
 IF NOT FOUND OR NOT public.inbox_validate_canonical_route(p_account,cm.conversation_id,cm.source_message_id,cm.origin_connection_id) OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=p_canonical AND claim_token=p_claim AND state='claimed') THEN RETURN 'review'; END IF;
 SELECT c.contact_id,m.created_at,ep.valid_from,reply.provider_message_id INTO cid,ts,start_at,quoted_native
 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id AND c.account_id=p_account
 JOIN public.whatsapp_channel_memberships ep ON ep.id=cm.origin_membership_id AND ep.account_id=p_account
 LEFT JOIN public.messages reply ON reply.id=m.reply_to_message_id AND reply.conversation_id=m.conversation_id AND reply.provider='openwa' AND reply.connection_id=cm.origin_connection_id
 WHERE m.id=cm.source_message_id;
 SELECT array_agg(id) INTO ids FROM (SELECT br.id FROM public.broadcast_recipients br JOIN public.broadcasts b ON b.id=br.broadcast_id AND b.account_id=p_account
 WHERE br.contact_id=cid AND br.connection_id=cm.origin_connection_id AND br.provider='openwa' AND br.status IN ('sent','delivered','read')
 AND br.sent_at>=start_at AND br.sent_at<=ts AND (quoted_native IS NULL OR br.provider_message_id=quoted_native)
 ORDER BY br.id LIMIT 2 FOR UPDATE OF br) q;
 IF coalesce(cardinality(ids),0)=0 THEN RETURN 'none'; END IF;
 IF cardinality(ids)<>1 THEN RETURN 'review'; END IF;
 UPDATE public.broadcast_recipients SET status='replied',replied_at=clock_timestamp() WHERE id=ids[1] AND connection_id=cm.origin_connection_id AND provider='openwa' AND status IN ('sent','delivered','read');
 RETURN CASE WHEN FOUND THEN 'updated' ELSE 'none' END;
END $$;
REVOKE ALL ON FUNCTION public.inbox_correlate_broadcast_reply(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_correlate_broadcast_reply(uuid,uuid,uuid) TO service_role;
