-- SCH-1: account pause must also prevent claiming already-materialized firings.
-- Additive function replacement; preserves original lease/retry/tenant contracts.
create or replace function public.claim_next_agent_task_trigger_firing(
  p_worker_id text,
  p_lease_secs integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_firing_id uuid;
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id
    into v_firing_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = firing.account_id
    ), true)
    and (
      (
        firing.status in ('pending', 'failed')
        and firing.available_at <= pg_catalog.now()
      )
      or
      (
        firing.status = 'claimed'
        and firing.lease_expires_at is not null
        and firing.lease_expires_at <= pg_catalog.now()
      )
    )
    and firing.attempts < 5
  order by firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         claimed_by = btrim(p_worker_id),
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

  select jsonb_build_object(
    'firing_id', firing.id,
    'account_id', firing.account_id,
    'trigger_id', trigger.id,
    'task_type', trigger.task_type,
    'task_type_version', trigger.task_type_version,
    'agent_id', trigger.agent_id,
    'trigger_kind', trigger.trigger_kind,
    'config', trigger.config,
    'filters', trigger.filters,
    'created_by', trigger.created_by,
    'source_key', firing.source_key,
    'scheduled_for', firing.scheduled_for,
    'attempts', firing.attempts,
    'business_event',
      case
        when event.id is null then null
        else jsonb_build_object(
          'id', event.id,
          'event_type', event.event_type,
          'event_version', event.event_version,
          'subject_type', event.subject_type,
          'subject_id', event.subject_id,
          'correlation_id', event.correlation_id,
          'causation_id', event.causation_id,
          'payload', event.payload,
          'created_at', event.created_at
        )
      end
  )
    into v_result
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.business_event_outbox as event
    on event.id = firing.business_event_id
   and event.account_id = firing.account_id
  where firing.id = v_firing_id;

  return v_result;
end;
$$;

revoke all on function public.claim_next_agent_task_trigger_firing(text,integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task_trigger_firing(text,integer)
  to service_role;

