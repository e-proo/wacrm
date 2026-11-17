-- SCH-2: review-bound control at the database boundary, no tenant or agent revision races.
-- Additive, leaving the historical service-only set_agent_task_trigger_status RPC unchanged.
create or replace function public.set_reviewed_agent_task_trigger_status(
  p_account_id uuid,
  p_trigger_id uuid,
  p_status text,
  p_actor_user_id uuid
) returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_trigger public.ai_agent_task_triggers%rowtype;
begin
  if p_status not in ('paused','enabled') or p_status is null then
    raise exception 'AGENT_TASK_TRIGGER_STATUS_INVALID';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id=p_actor_user_id and p.account_id=p_account_id
      and p.account_role in ('owner','admin')
  ) then
    raise exception 'AGENT_TASK_TRIGGER_CONTROL_UNAUTHORIZED';
  end if;

  select * into v_trigger
  from public.ai_agent_task_triggers
  where id=p_trigger_id and account_id=p_account_id
  for update;
  if not found or v_trigger.status='completed' then
    return false;
  end if;

  if p_status='enabled' then
    if not exists (
      select 1 from public.profiles p
      where p.user_id=p_actor_user_id and p.account_id=p_account_id
        and p.account_role='owner'
    ) then
      raise exception 'AGENT_TASK_TRIGGER_ENABLE_OWNER_ONLY';
    end if;
    if v_trigger.approved_revision_id is null
      or v_trigger.approved_by is null
      or not exists (
        select 1 from public.ai_agents a
        join public.ai_agent_revisions rev
          on rev.id=a.published_revision_id
         and rev.agent_id=a.id and rev.account_id=a.account_id
        where a.account_id=p_account_id
          and a.id=v_trigger.agent_id
          and a.status='active'
          and rev.status='published'
          and rev.id=v_trigger.approved_revision_id
      ) then
      raise exception 'AGENT_TASK_TRIGGER_REVIEW_REVISION_CHANGED';
    end if;
  end if;

  update public.ai_agent_task_triggers
  set status=p_status,updated_at=now()
  where id=p_trigger_id and account_id=p_account_id
    and status<>'completed';
  return found;
end;
$$;
revoke all on function public.set_reviewed_agent_task_trigger_status(uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.set_reviewed_agent_task_trigger_status(uuid,uuid,text,uuid)
  to service_role;
