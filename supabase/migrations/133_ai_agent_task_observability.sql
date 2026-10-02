-- ============================================================
-- 133_ai_agent_task_observability.sql
-- Phase 15: redacted Task trace + account-scoped Task metrics.
-- No message bodies, tool args, prompts, secrets, or hidden model reasoning.
-- ============================================================

-- Backfill only deterministic lineage that can be proven from durable ids.
insert into public.ai_agent_business_outcome_links (
  account_id,
  run_id,
  task_id,
  task_target_id,
  outcome_type,
  outcome_id,
  outcome_status
)
select
  event.account_id,
  change.source_run_id,
  run.task_id,
  run.task_target_id,
  'business_event',
  event.id::text,
  event.status
from public.business_event_outbox as event
join public.change_requests as change
  on change.account_id=event.account_id
 and change.id::text=event.correlation_id
 and change.source_run_id is not null
join public.ai_agent_runs as run
  on run.account_id=event.account_id
 and run.id=change.source_run_id
on conflict (account_id,run_id,outcome_type,outcome_id)
do update set
  outcome_status=excluded.outcome_status,
  updated_at=pg_catalog.now();

insert into public.ai_agent_business_outcome_links (
  account_id,
  run_id,
  task_id,
  task_target_id,
  outcome_type,
  outcome_id,
  outcome_status
)
select
  intent.account_id,
  run.id,
  run.task_id,
  run.task_target_id,
  'customer_intent',
  intent.id::text,
  intent.status
from public.customer_intents as intent
join public.ai_agent_runs as run
  on run.account_id=intent.account_id
 and run.inbound_message_id=intent.source_message_id
where intent.source_message_id is not null
  and run.task_id is not null
on conflict (account_id,run_id,outcome_type,outcome_id)
do update set
  outcome_status=excluded.outcome_status,
  updated_at=pg_catalog.now();

create or replace function public.inspect_ai_agent_task_trace(
  p_account_id uuid,
  p_task_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
begin
  select task.*
    into v_task
  from public.ai_agent_tasks as task
  where task.account_id=p_account_id
    and task.id=p_task_id;

  if v_task.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'task',
      jsonb_build_object(
        'id',v_task.id,
        'task_type',v_task.task_type,
        'task_type_version',v_task.task_type_version,
        'agent_id',v_task.agent_id,
        'agent_revision_id',v_task.agent_revision_id,
        'trigger_type',v_task.trigger_type,
        'trigger_ref',v_task.trigger_ref,
        'status',v_task.status,
        'channel',v_task.channel,
        'correlation_id',v_task.correlation_id,
        'created_at',v_task.created_at,
        'started_at',v_task.started_at,
        'completed_at',v_task.completed_at
      ),
    'targets',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',target.id,
            'status',target.status,
            'counterparty_role',target.counterparty_role,
            'attempt_count',target.attempt_count,
            'resolver_key',target.resolver_key,
            'resolver_version',target.resolver_version,
            'first_contacted_at',target.first_contacted_at,
            'replied_at',target.replied_at,
            'completed_at',target.completed_at,
            'skip_reason',target.skip_reason,
            'failure_code',target.failure_code,
            'created_at',target.created_at,
            'updated_at',target.updated_at
          )
          order by target.created_at,target.id
        )
        from public.ai_agent_task_targets as target
        where target.account_id=p_account_id
          and target.task_id=p_task_id
      ),'[]'::jsonb),
    'task_events',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',event.id,
            'task_target_id',event.task_target_id,
            'run_id',event.run_id,
            'event_type',event.event_type,
            'outcome',nullif(event.payload->>'outcome',''),
            'reason',nullif(event.payload->>'reason',''),
            'actor_type',event.actor_type,
            'created_at',event.created_at
          )
          order by event.created_at,event.id
        )
        from public.ai_agent_task_events as event
        where event.account_id=p_account_id
          and event.task_id=p_task_id
      ),'[]'::jsonb),
    'runs',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',run.id,
            'task_target_id',run.task_target_id,
            'run_mode',run.run_mode,
            'trigger_type',run.trigger_type,
            'trigger_ref',run.trigger_ref,
            'status',run.status,
            'attempt_count',run.attempt_count,
            'provider_connection_id',run.provider_connection_id,
            'input_tokens',run.input_tokens,
            'output_tokens',run.output_tokens,
            'estimated_provider_cost_micros',
              run.estimated_provider_cost_micros,
            'provider_cost_micros',run.provider_cost_micros,
            'error_code',run.error_code,
            'inbound_message_id',run.inbound_message_id,
            'outbound_message_id',run.outbound_message_id,
            'created_at',run.created_at,
            'started_at',run.started_at,
            'completed_at',run.completed_at
          )
          order by run.created_at,run.id
        )
        from public.ai_agent_runs as run
        where run.account_id=p_account_id
          and run.task_id=p_task_id
      ),'[]'::jsonb),
    'tool_calls',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',attempt.id,
            'run_id',attempt.run_id,
            'tool_key',attempt.tool_key,
            'tool_version',attempt.tool_version,
            'round',attempt.round,
            'permission',attempt.permission,
            'status',attempt.status,
            'error_code',attempt.error_code,
            'duration_ms',attempt.duration_ms,
            'created_at',attempt.created_at
          )
          order by attempt.created_at,attempt.id
        )
        from public.ai_agent_tool_call_attempts as attempt
        join public.ai_agent_runs as run
          on run.account_id=attempt.account_id
         and run.id=attempt.run_id
        where attempt.account_id=p_account_id
          and run.task_id=p_task_id
      ),'[]'::jsonb),
    'outbound_messages',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',outbound.id,
            'run_id',outbound.run_id,
            'task_target_id',outbound.task_target_id,
            'attempt_number',outbound.attempt_number,
            'policy_key',outbound.policy_key,
            'policy_version',outbound.policy_version,
            'message_kind',outbound.message_kind,
            'template_name',outbound.template_name,
            'template_language',outbound.template_language,
            'status',outbound.status,
            'local_message_id',outbound.local_message_id,
            'whatsapp_message_id',outbound.whatsapp_message_id,
            'error_code',outbound.error_code,
            'sent_at',outbound.sent_at,
            'created_at',outbound.created_at
          )
          order by outbound.created_at,outbound.id
        )
        from public.ai_agent_task_outbound_messages as outbound
        where outbound.account_id=p_account_id
          and outbound.task_id=p_task_id
      ),'[]'::jsonb),
    'replies',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'run_id',run.id,
            'task_target_id',run.task_target_id,
            'inbound_message_id',run.inbound_message_id,
            'reply_to_message_id',message.reply_to_message_id,
            'response_message_id',run.outbound_message_id,
            'status',run.status,
            'created_at',message.created_at
          )
          order by message.created_at,run.id
        )
        from public.ai_agent_runs as run
        join public.messages as message
          on message.id=run.inbound_message_id
         and message.conversation_id=run.conversation_id
        where run.account_id=p_account_id
          and run.task_id=p_task_id
          and run.trigger_type='task_reply'
      ),'[]'::jsonb),
    'change_requests',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',change.id,
            'code',change.code,
            'source_run_id',change.source_run_id,
            'action_key',change.action_key,
            'action_version',change.action_version,
            'target_type',change.target_type,
            'target_id',change.target_id,
            'intent',change.intent,
            'status',change.status,
            'approved_run_id',change.approved_run_id,
            'error_code',change.error_code,
            'created_at',change.created_at,
            'approved_at',change.approved_at,
            'executed_at',change.executed_at
          )
          order by change.created_at,change.id
        )
        from public.change_requests as change
        join public.ai_agent_runs as run
          on run.account_id=change.account_id
         and run.id=change.source_run_id
        where change.account_id=p_account_id
          and run.task_id=p_task_id
      ),'[]'::jsonb),
    'business_outcomes',
      coalesce((
        select jsonb_agg(
          jsonb_strip_nulls(
            jsonb_build_object(
              'link_id',link.id,
              'run_id',link.run_id,
              'task_target_id',link.task_target_id,
              'outcome_type',link.outcome_type,
              'outcome_id',link.outcome_id,
              'outcome_status',link.outcome_status,
              'business_event_type',event.event_type,
              'business_event_version',event.event_version,
              'business_subject_type',event.subject_type,
              'business_subject_id',event.subject_id,
              'intent_direction',intent.direction,
              'intent_status',intent.status,
              'created_at',link.created_at
            )
          )
          order by link.created_at,link.id
        )
        from public.ai_agent_business_outcome_links as link
        left join public.business_event_outbox as event
          on link.outcome_type='business_event'
         and event.account_id=link.account_id
         and event.id::text=link.outcome_id
        left join public.customer_intents as intent
          on link.outcome_type='customer_intent'
         and intent.account_id=link.account_id
         and intent.id::text=link.outcome_id
        where link.account_id=p_account_id
          and link.task_id=p_task_id
      ),'[]'::jsonb),
    'circuit_events',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',event.id,
            'run_id',event.run_id,
            'scope_type',event.scope_type,
            'scope_key',event.scope_key,
            'outcome',event.outcome,
            'error_code',event.error_code,
            'state_after',event.state_after,
            'created_at',event.created_at
          )
          order by event.created_at,event.id
        )
        from public.ai_agent_circuit_events as event
        where event.account_id=p_account_id
          and event.task_id=p_task_id
      ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.inspect_ai_agent_task_trace(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.inspect_ai_agent_task_trace(uuid,uuid)
  to service_role;

create or replace function public.inspect_ai_agent_task_metrics(
  p_account_id uuid,
  p_from timestamptz default (now()-interval '30 days'),
  p_to timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_tasks_started bigint:=0;
  v_tasks_completed bigint:=0;
  v_targets_selected bigint:=0;
  v_targets_skipped bigint:=0;
  v_contacts_reached bigint:=0;
  v_replies bigint:=0;
  v_positive_replies bigint:=0;
  v_business_outcomes bigint:=0;
  v_avg_attempts numeric:=0;
  v_tool_failures bigint:=0;
  v_provider_failures bigint:=0;
  v_meta_failures bigint:=0;
  v_input_tokens bigint:=0;
  v_output_tokens bigint:=0;
  v_provider_cost_micros bigint:=0;
  v_estimated_provider_cost_micros bigint:=0;
  v_uncosted_runs bigint:=0;
  v_sent_messages bigint:=0;
  v_human_handoffs bigint:=0;
  v_opt_outs bigint:=0;
begin
  if p_from is null or p_to is null or p_from>=p_to then
    raise exception 'AI_TASK_METRICS_WINDOW_INVALID';
  end if;
  if p_to-p_from>interval '366 days' then
    raise exception 'AI_TASK_METRICS_WINDOW_TOO_LARGE';
  end if;

  select count(*)
    into v_tasks_started
  from public.ai_agent_tasks
  where account_id=p_account_id
    and created_at>=p_from
    and created_at<p_to;

  select count(*)
    into v_tasks_completed
  from public.ai_agent_tasks
  where account_id=p_account_id
    and completed_at>=p_from
    and completed_at<p_to
    and status in ('completed','partially_completed');

  select
    count(*),
    coalesce(avg(attempt_count),0),
    count(*) filter (
      where first_contacted_at>=p_from and first_contacted_at<p_to
    ),
    count(*) filter (
      where replied_at>=p_from and replied_at<p_to
    ),
    count(*) filter (
      where status='skipped'
        and completed_at>=p_from and completed_at<p_to
    ),
    count(*) filter (
      where status='opted_out'
        and coalesce(completed_at,updated_at)>=p_from
        and coalesce(completed_at,updated_at)<p_to
    )
  into
    v_targets_selected,
    v_avg_attempts,
    v_contacts_reached,
    v_replies,
    v_targets_skipped,
    v_opt_outs
  from public.ai_agent_task_targets
  where account_id=p_account_id
    and created_at<p_to
    and (
      created_at>=p_from
      or first_contacted_at>=p_from
      or replied_at>=p_from
      or completed_at>=p_from
      or updated_at>=p_from
    );

  select count(*)
    into v_business_outcomes
  from public.ai_agent_business_outcome_links
  where account_id=p_account_id
    and task_id is not null
    and created_at>=p_from
    and created_at<p_to;

  select count(distinct link.task_target_id)
    into v_positive_replies
  from public.ai_agent_business_outcome_links as link
  left join public.business_event_outbox as event
    on link.outcome_type='business_event'
   and event.account_id=link.account_id
   and event.id::text=link.outcome_id
  where link.account_id=p_account_id
    and link.task_id is not null
    and link.task_target_id is not null
    and link.created_at>=p_from
    and link.created_at<p_to
    and (
      link.outcome_type='customer_intent'
      or (
        link.outcome_type='business_event'
        and event.event_type in (
          'coverage.offer.approved',
          'coverage.request.approved',
          'service_request.approved',
          'service_request.matched'
        )
      )
    );

  select count(*)
    into v_tool_failures
  from public.ai_agent_tool_call_attempts as attempt
  join public.ai_agent_runs as run
    on run.account_id=attempt.account_id
   and run.id=attempt.run_id
  where attempt.account_id=p_account_id
    and run.task_id is not null
    and attempt.status='failed'
    and attempt.created_at>=p_from
    and attempt.created_at<p_to;

  select
    count(*) filter (
      where scope_type='provider' and outcome='failure'
    ),
    count(*) filter (
      where scope_type='channel'
        and scope_key='whatsapp'
        and outcome='failure'
    )
  into v_provider_failures,v_meta_failures
  from public.ai_agent_circuit_events
  where account_id=p_account_id
    and task_id is not null
    and created_at>=p_from
    and created_at<p_to;

  select
    coalesce(sum(coalesce(input_tokens,0)),0),
    coalesce(sum(coalesce(output_tokens,0)),0),
    coalesce(sum(coalesce(provider_cost_micros,0)),0),
    coalesce(sum(coalesce(estimated_provider_cost_micros,0)),0),
    count(*) filter (
      where provider_cost_micros is null
        and (coalesce(input_tokens,0)>0 or coalesce(output_tokens,0)>0)
    )
  into
    v_input_tokens,
    v_output_tokens,
    v_provider_cost_micros,
    v_estimated_provider_cost_micros,
    v_uncosted_runs
  from public.ai_agent_runs
  where account_id=p_account_id
    and task_id is not null
    and created_at>=p_from
    and created_at<p_to;

  select count(*)
    into v_sent_messages
  from public.ai_agent_task_outbound_messages
  where account_id=p_account_id
    and status='sent'
    and sent_at>=p_from
    and sent_at<p_to;

  select count(*)
    into v_human_handoffs
  from public.ai_agent_task_events
  where account_id=p_account_id
    and event_type='target.paused_for_human'
    and created_at>=p_from
    and created_at<p_to;

  return jsonb_build_object(
    'window',
      jsonb_build_object(
        'from',p_from,
        'to',p_to
      ),
    'tasks_started',v_tasks_started,
    'tasks_completed',v_tasks_completed,
    'targets_selected',v_targets_selected,
    'targets_skipped',v_targets_skipped,
    'contacts_reached',v_contacts_reached,
    'replies',v_replies,
    'reply_rate',
      case
        when v_contacts_reached=0 then 0
        else round(v_replies::numeric/v_contacts_reached,4)
      end,
    'positive_replies',v_positive_replies,
    'positive_reply_rate',
      case
        when v_replies=0 then 0
        else round(v_positive_replies::numeric/v_replies,4)
      end,
    'positive_reply_basis',
      'direct_customer_intent_or_positive_business_event',
    'business_outcomes',v_business_outcomes,
    'avg_attempts_per_target',round(coalesce(v_avg_attempts,0),4),
    'tool_failures',v_tool_failures,
    'provider_failures',v_provider_failures,
    'meta_failures',v_meta_failures,
    'input_tokens',v_input_tokens,
    'output_tokens',v_output_tokens,
    'provider_cost_micros',v_provider_cost_micros,
    'estimated_provider_cost_micros',v_estimated_provider_cost_micros,
    'uncosted_runs',v_uncosted_runs,
    'sent_messages',v_sent_messages,
    'message_cost_micros',null,
    'message_cost_status','authoritative_channel_billing_rate_not_configured',
    'uncosted_sent_messages',v_sent_messages,
    'human_handoffs',v_human_handoffs,
    'opt_outs',v_opt_outs,
    'opt_out_rate',
      case
        when v_contacts_reached=0 then 0
        else round(v_opt_outs::numeric/v_contacts_reached,4)
      end
  );
end;
$$;

revoke all on function public.inspect_ai_agent_task_metrics(
  uuid,timestamptz,timestamptz
) from public,anon,authenticated;
grant execute on function public.inspect_ai_agent_task_metrics(
  uuid,timestamptz,timestamptz
) to service_role;
