-- ============================================================
-- 122_ai_agent_task_policy_finalization.sql
-- Generic atomic terminal transition owned by a registered completion policy.
-- The policy decides; SQL only validates/serializes the durable transition.
-- ============================================================

create or replace function public.finalize_agent_task_by_policy(
  p_task_id uuid,
  p_terminal_status text,
  p_policy_key text,
  p_policy_version integer,
  p_reason text,
  p_payload jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_event_type text;
begin
  if p_terminal_status not in (
    'completed',
    'partially_completed',
    'failed',
    'cancelled'
  ) then
    raise exception 'AGENT_TASK_POLICY_TERMINAL_STATUS_INVALID';
  end if;

  if length(btrim(coalesce(p_policy_key, ''))) = 0
     or p_policy_version < 1
     or length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'AGENT_TASK_POLICY_DECISION_INVALID';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'AGENT_TASK_POLICY_PAYLOAD_INVALID';
  end if;

  select task.*
    into v_task
  from public.ai_agent_tasks as task
  where task.id=p_task_id
  for update;

  if v_task.id is null or v_task.status <> 'running' then
    return false;
  end if;

  update public.ai_agent_tasks
     set status=p_terminal_status,
         completed_at=coalesce(completed_at, pg_catalog.now()),
         claimed_by=null,
         lease_expires_at=null,
         available_at=pg_catalog.now()
   where id=v_task.id
     and status='running';

  if not found then
    return false;
  end if;

  v_event_type :=
    case p_terminal_status
      when 'completed' then 'task.completed'
      when 'partially_completed' then 'task.partially_completed'
      when 'cancelled' then 'task.cancelled'
      else 'task.failed'
    end;

  perform public.append_agent_task_event(
    v_task.account_id,
    v_task.id,
    null,
    null,
    v_event_type,
    'service',
    p_policy_key,
    pg_catalog.jsonb_build_object(
      'policy_key',p_policy_key,
      'policy_version',p_policy_version,
      'reason',p_reason,
      'decision',p_payload
    )
  );

  return true;
end;
$$;

revoke all on function public.finalize_agent_task_by_policy(
  uuid,text,text,integer,text,jsonb
) from public,anon,authenticated;

grant execute on function public.finalize_agent_task_by_policy(
  uuid,text,text,integer,text,jsonb
) to service_role;
