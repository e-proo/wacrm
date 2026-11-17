-- SCH-1: expired leases cannot complete/fail work after ownership has lapsed.
-- Keep existing RPC signatures and service-role-only grants; additive replacement.
create or replace function public.complete_agent_task_trigger_firing(
  p_firing_id uuid,
  p_worker_id text,
  p_task_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.ai_agent_task_trigger_firings
     set status = 'completed',
         task_id = p_task_id,
         claimed_by = null,
         lease_expires_at = null,
         last_error = null,
         updated_at = pg_catalog.now()
   where id = p_firing_id
     and status = 'claimed'
     and claimed_by = p_worker_id
     and lease_expires_at > pg_catalog.now();

  return found;
end;
$$;

revoke all on function public.complete_agent_task_trigger_firing(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_agent_task_trigger_firing(uuid,text,uuid)
  to service_role;

create or replace function public.fail_agent_task_trigger_firing(
  p_firing_id uuid,
  p_worker_id text,
  p_error text,
  p_delay_secs integer default 60
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_status text;
begin
  if p_delay_secs < 0 or p_delay_secs > 86400 then
    raise exception 'AGENT_TASK_TRIGGER_RETRY_DELAY_INVALID';
  end if;

  select attempts
    into v_attempts
  from public.ai_agent_task_trigger_firings
  where id = p_firing_id
    and status = 'claimed'
    and claimed_by = p_worker_id
    and lease_expires_at > pg_catalog.now()
  for update;

  if v_attempts is null then
    return null;
  end if;

  v_status := case when v_attempts >= 5 then 'dead' else 'failed' end;

  update public.ai_agent_task_trigger_firings
     set status = v_status,
         available_at =
           case
             when v_status = 'failed'
               then pg_catalog.now() + make_interval(secs => p_delay_secs)
             else available_at
           end,
         claimed_by = null,
         lease_expires_at = null,
         last_error = left(coalesce(p_error, 'AGENT_TASK_TRIGGER_FAILED'), 1000),
         updated_at = pg_catalog.now()
   where id = p_firing_id;

  return v_status;
end;
$$;

revoke all on function public.fail_agent_task_trigger_firing(
  uuid,text,text,integer
) from public, anon, authenticated;
grant execute on function public.fail_agent_task_trigger_firing(
  uuid,text,text,integer
) to service_role;
