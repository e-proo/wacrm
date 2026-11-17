-- SCH-5: terminalize a fifth-attempt firing if its lease expires due to
-- a crash. Earlier attempts remain reclaimable by the existing claim RPC.
-- No Task or WhatsApp message is created, resent, deleted or altered here.
create or replace function public.reap_expired_agent_task_trigger_firings(
  p_limit integer default 100
) returns integer language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_reaped integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'AGENT_TASK_TRIGGER_REAPER_LIMIT_INVALID';
  end if;
  with expired as materialized (
    select f.id
    from public.ai_agent_task_trigger_firings as f
    where f.status = 'claimed'
      and f.attempts >= 5
      and f.lease_expires_at is not null
      and f.lease_expires_at <= pg_catalog.now()
    order by f.lease_expires_at asc, f.id asc
    for update skip locked
    limit least(p_limit,100)
  )
  update public.ai_agent_task_trigger_firings as f
  set status='dead',
      claimed_by=null,
      lease_expires_at=null,
      last_error='AGENT_TASK_TRIGGER_LEASE_RETRIES_EXHAUSTED',
      updated_at=pg_catalog.now()
  from expired
  where f.id=expired.id
    and f.status='claimed'
    and f.attempts>=5
    and f.lease_expires_at<=pg_catalog.now();
  get diagnostics v_reaped = row_count;
  return v_reaped;
end;
$$;
revoke all on function public.reap_expired_agent_task_trigger_firings(integer)
 from public, anon, authenticated;
grant execute on function public.reap_expired_agent_task_trigger_firings(integer)
 to service_role;
