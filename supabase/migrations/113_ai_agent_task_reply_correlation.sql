-- ============================================================
-- 113_ai_agent_task_reply_correlation.sql
-- Durable inbound reply correlation for Agent Tasks.
--
-- Preserves trusted-admin precedence in the application router.
-- Adds no domain-specific Coverage/Services branching to the webhook.
-- ============================================================

alter table public.ai_agent_task_targets
  drop constraint if exists ai_agent_task_targets_status_check;

alter table public.ai_agent_task_targets
  add constraint ai_agent_task_targets_status_check
  check (status in (
    'candidate',
    'eligible',
    'queued',
    'preparing',
    'sending',
    'contacted',
    'awaiting_reply',
    'replied',
    'in_progress',
    'paused_for_human',
    'completed',
    'skipped',
    'failed',
    'opted_out',
    'exhausted'
  )) not valid;

alter table public.ai_agent_task_targets
  validate constraint ai_agent_task_targets_status_check;

alter table public.ai_agent_runs
  drop constraint if exists ai_agent_runs_source_shape_check;

alter table public.ai_agent_runs
  add constraint ai_agent_runs_source_shape_check
  check (
    (
      run_mode = 'inbound'
      and inbound_message_id is not null
      and (
        (
          task_id is null
          and task_target_id is null
          and trigger_type <> 'task_reply'
        )
        or
        (
          task_id is not null
          and task_target_id is not null
          and trigger_type = 'task_reply'
        )
      )
    )
    or
    (
      run_mode = 'outbound'
      and inbound_message_id is null
      and task_id is not null
      and task_target_id is not null
    )
    or
    (
      run_mode = 'simulation'
      and inbound_message_id is null
    )
  ) not valid;

alter table public.ai_agent_runs
  validate constraint ai_agent_runs_source_shape_check;

drop index if exists public.ai_agent_task_targets_orchestrator_due_idx;
create index ai_agent_task_targets_orchestrator_due_idx
  on public.ai_agent_task_targets (task_id, available_at, created_at)
  where status in ('eligible', 'queued');

create index if not exists ai_agent_task_targets_reply_lookup_idx
  on public.ai_agent_task_targets (
    account_id,
    conversation_id,
    status,
    updated_at desc
  )
  where last_outbound_message_id is not null
    and status in (
      'queued',
      'preparing',
      'contacted',
      'awaiting_reply',
      'replied',
      'in_progress'
    );

create or replace function public.pause_agent_task_targets_for_human(
  p_account_id uuid,
  p_conversation_id uuid,
  p_actor_id text default 'human_assignment',
  p_reason text default 'human_takeover'
) returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  r record;
  v_count integer := 0;
begin
  -- Match the transport lock order: reservation -> run -> target. This avoids
  -- a target-first / reservation-first deadlock with
  -- claim_agent_task_outbound_message().
  for r in
    select target.id, target.task_id
    from public.ai_agent_task_targets as target
    where target.account_id=p_account_id
      and target.conversation_id=p_conversation_id
      and target.status in (
        'candidate',
        'eligible',
        'queued',
        'preparing',
        'sending',
        'contacted',
        'awaiting_reply',
        'replied',
        'in_progress'
      )
    order by target.created_at, target.id
  loop
    update public.ai_agent_task_outbound_messages
       set status='cancelled',
           claimed_by=null,
           lease_expires_at=null,
           error_code='HUMAN_TAKEOVER',
           error_detail=left(coalesce(p_reason,'human_takeover'),1000)
     where account_id=p_account_id
       and task_id=r.task_id
       and task_target_id=r.id
       and status='reserved';

    update public.ai_agent_runs as run
       set status='cancelled',
           completed_at=coalesce(run.completed_at,now()),
           claimed_by=null,
           lease_expires_at=null,
           error_code='HUMAN_TAKEOVER'
     where run.account_id=p_account_id
       and run.task_id=r.task_id
       and run.task_target_id=r.id
       and run.run_mode='outbound'
       and run.status in ('queued','claimed')
       and not exists (
         select 1
         from public.ai_agent_task_outbound_messages as outbound
         where outbound.run_id=run.id
           and outbound.status='sending'
       );

    update public.ai_agent_task_targets as target
       set status='paused_for_human',
           next_action_at=null,
           available_at=now(),
           claimed_by=null,
           lease_expires_at=null,
           failure_code=null
     where target.id=r.id
       and target.account_id=p_account_id
       and target.task_id=r.task_id
       and target.status in (
         'candidate',
         'eligible',
         'queued',
         'preparing',
         'sending',
         'contacted',
         'awaiting_reply',
         'replied',
         'in_progress'
       );

    if found then
      v_count := v_count + 1;

      perform public.append_agent_task_event(
        p_account_id,
        r.task_id,
        r.id,
        null,
        'target.paused_for_human',
        'service',
        nullif(p_actor_id,''),
        jsonb_build_object(
          'conversation_id',p_conversation_id,
          'reason',coalesce(p_reason,'human_takeover')
        )
      );
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.pause_agent_task_targets_for_human(
  uuid,uuid,text,text
) from public,anon,authenticated;
grant execute on function public.pause_agent_task_targets_for_human(
  uuid,uuid,text,text
) to service_role;

create or replace function public.pause_agent_task_targets_on_assignment()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.assigned_agent_id is not null
     and new.assigned_agent_id is distinct from old.assigned_agent_id then
    perform public.pause_agent_task_targets_for_human(
      new.account_id,
      new.id,
      new.assigned_agent_id::text,
      'conversation_assigned_to_human'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.pause_agent_task_targets_on_assignment()
  from public,anon,authenticated;

drop trigger if exists pause_agent_task_targets_on_assignment
  on public.conversations;
create trigger pause_agent_task_targets_on_assignment
  after update of assigned_agent_id on public.conversations
  for each row
  when (
    new.assigned_agent_id is not null
    and new.assigned_agent_id is distinct from old.assigned_agent_id
  )
  execute function public.pause_agent_task_targets_on_assignment();

do $$
declare
  r record;
begin
  for r in
    select id, account_id, assigned_agent_id
    from public.conversations
    where assigned_agent_id is not null
  loop
    perform public.pause_agent_task_targets_for_human(
      r.account_id,
      r.id,
      r.assigned_agent_id::text,
      'migration_existing_human_assignment'
    );
  end loop;
end
$$;

create or replace function public.claim_next_agent_task_target(
  p_task_id uuid,
  p_worker_id text,
  p_lease_secs integer default 120
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_max_targets integer;
  v_max_attempts integer;
  v_target_id uuid;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 1 or p_lease_secs > 3600 then
    raise exception 'AGENT_TASK_TARGET_LEASE_INVALID';
  end if;

  select t.account_id, t.max_targets, t.max_attempts_per_target
    into v_account_id, v_max_targets, v_max_attempts
  from public.ai_agent_tasks as t
  where t.id = p_task_id
    and t.status = 'running'
    and t.claimed_by = p_worker_id
    and t.lease_expires_at > now()
  for update;

  if v_account_id is null then
    return null;
  end if;

  with ranked as (
    select
      target.id,
      row_number() over (
        order by target.created_at asc, target.id asc
      ) as target_ordinal
    from public.ai_agent_task_targets as target
    where target.task_id = p_task_id
  ),
  candidate as (
    select target.id
    from public.ai_agent_task_targets as target
    join ranked on ranked.id = target.id
    where target.account_id = v_account_id
      and target.task_id = p_task_id
      and ranked.target_ordinal <= v_max_targets
      and target.status in ('eligible', 'queued')
      and target.attempt_count < v_max_attempts
      and target.available_at <= now()
      and (target.next_action_at is null or target.next_action_at <= now())
      and (target.lease_expires_at is null or target.lease_expires_at < now())
    order by target.available_at asc, target.created_at asc, target.id asc
    for update of target skip locked
    limit 1
  )
  update public.ai_agent_task_targets as target
     set status = 'preparing',
         claimed_by = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_secs),
         attempt_count = target.attempt_count + 1,
         last_attempt_at = now(),
         failure_code = null
    from candidate
   where target.id = candidate.id
  returning target.id into v_target_id;

  if v_target_id is not null then
    perform public.append_agent_task_event(
      v_account_id,
      p_task_id,
      v_target_id,
      null,
      'target.claimed',
      'service',
      p_worker_id,
      jsonb_build_object('lease_secs', p_lease_secs)
    );
  end if;

  return v_target_id;
end;
$$;

revoke all on function public.claim_next_agent_task_target(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_next_agent_task_target(uuid,text,integer)
  to service_role;

create or replace function public.complete_agent_task_outbound_message(
  p_reservation_id uuid,
  p_worker_id text,
  p_local_message_id uuid,
  p_whatsapp_message_id text,
  p_input_tokens integer,
  p_output_tokens integer
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_task_outbound_messages%rowtype;
begin
  select * into v_row
  from public.ai_agent_task_outbound_messages
  where id=p_reservation_id
    and status='sending'
    and claimed_by=p_worker_id
  for update;

  if v_row.id is null then
    return false;
  end if;

  update public.ai_agent_task_outbound_messages
  set status='sent',
      local_message_id=p_local_message_id,
      whatsapp_message_id=nullif(btrim(coalesce(p_whatsapp_message_id,'')),''),
      sent_at=now(),
      claimed_by=null,
      lease_expires_at=null,
      error_code=null,
      error_detail=null
  where id=v_row.id;

  update public.ai_agent_runs
  set status='succeeded',
      completed_at=now(),
      outbound_message_id=p_local_message_id,
      input_tokens=greatest(coalesce(p_input_tokens,0),0),
      output_tokens=greatest(coalesce(p_output_tokens,0),0),
      error_code=null
  where id=v_row.run_id
    and account_id=v_row.account_id
    and task_id=v_row.task_id
    and status='claimed';

  update public.ai_agent_task_targets as target
  set status=case
        when target.status='paused_for_human' then 'paused_for_human'
        else 'awaiting_reply'
      end,
      first_contacted_at=coalesce(target.first_contacted_at,now()),
      last_outbound_message_id=p_local_message_id,
      failure_code=null,
      next_action_at=null,
      available_at=now()
  where target.id=v_row.task_target_id
    and target.account_id=v_row.account_id
    and target.task_id=v_row.task_id;

  perform public.append_agent_task_event(
    v_row.account_id,v_row.task_id,v_row.task_target_id,v_row.run_id,
    'message.sent','service',p_worker_id,
    jsonb_build_object(
      'reservation_id',v_row.id,
      'message_kind',v_row.message_kind,
      'local_message_id',p_local_message_id,
      'whatsapp_message_id',coalesce(p_whatsapp_message_id,''),
      'attempt',v_row.attempt_number
    )
  );

  return true;
end;
$$;

revoke all on function public.complete_agent_task_outbound_message(
  uuid,text,uuid,text,integer,integer
) from public,anon,authenticated;
grant execute on function public.complete_agent_task_outbound_message(
  uuid,text,uuid,text,integer,integer
) to service_role;

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

revoke all on function public.correlate_agent_task_inbound_reply(
  uuid,uuid,uuid,uuid,boolean
) from public,anon,authenticated;
grant execute on function public.correlate_agent_task_inbound_reply(
  uuid,uuid,uuid,uuid,boolean
) to service_role;
