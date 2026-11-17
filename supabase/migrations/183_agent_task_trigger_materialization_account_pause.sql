-- SCH-1 additive follow-up: honor account-level Task worker pause at both schedule and business-event materialization.
-- The worker claim already enforces the account pause; materialization must not advance next_fire_at while paused.
create or replace function public.materialize_agent_task_trigger_firings(
  p_now timestamptz default now(),
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.ai_agent_task_triggers%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_schedule_count integer := 0;
  v_event_count integer := 0;
  v_missed bigint := 0;
  v_occurrence timestamptz;
begin
  for r in
    select trigger.*
    from public.ai_agent_task_triggers as trigger
    where trigger.status = 'enabled'
      and trigger.trigger_kind = 'schedule'
      and trigger.next_fire_at is not null
      and trigger.next_fire_at <= p_now
      and coalesce((
        select policy.task_worker_enabled
        from public.ai_runtime_policies as policy
        where policy.account_id = trigger.account_id
      ), true)
    order by trigger.next_fire_at asc, trigger.id asc
    for update skip locked
    limit v_limit
  loop
    -- Collapse historical intervals to the latest due occurrence, never replay a burst.
    v_missed := case when r.schedule_kind = 'recurring' then
      greatest(0, floor(extract(epoch from (p_now - r.next_fire_at)) /
        (r.interval_minutes * 60.0))::bigint) else 0 end;
    v_occurrence := r.next_fire_at +
      (make_interval(mins => coalesce(r.interval_minutes, 0)) * v_missed::double precision);
    insert into public.ai_agent_task_trigger_firings (
      account_id,
      trigger_id,
      source_kind,
      source_key,
      scheduled_for,
      available_at
    ) values (
      r.account_id,
      r.id,
      'schedule',
      'schedule:' || r.id::text || ':' ||
        to_char(v_occurrence at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'),
      v_occurrence,
      p_now
    )
    on conflict (trigger_id, source_key) do nothing;

    if found then
      v_schedule_count := v_schedule_count + 1;
    end if;

    if r.schedule_kind = 'once' then
      update public.ai_agent_task_triggers
         set status = 'completed',
             next_fire_at = null,
             updated_at = p_now
       where id = r.id;
    else
      update public.ai_agent_task_triggers
         set next_fire_at =
               v_occurrence + make_interval(mins => r.interval_minutes),
             skipped_occurrences = skipped_occurrences + v_missed,
             updated_at = p_now
       where id = r.id;
    end if;
  end loop;

  insert into public.ai_agent_task_trigger_firings (
    account_id,
    trigger_id,
    source_kind,
    source_key,
    business_event_id,
    available_at
  )
  select
    trigger.account_id,
    trigger.id,
    'business_event',
    'event:' || event.id::text,
    event.id,
    p_now
  from public.ai_agent_task_triggers as trigger
  join public.business_event_outbox as event
    on event.account_id = trigger.account_id
   and event.event_type = trigger.event_type
   and event.event_version = trigger.event_version
   and event.created_at >= trigger.created_at
  where trigger.status = 'enabled'
    and trigger.trigger_kind = 'business_event'
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = trigger.account_id
    ), true)
    and (
      not (trigger.filters ? 'subject_type')
      or event.subject_type = trigger.filters ->> 'subject_type'
    )
    and (
      not (trigger.filters ? 'subject_id')
      or event.subject_id = trigger.filters ->> 'subject_id'
    )
    and (
      not (trigger.filters ? 'payload_contains')
      or (
        jsonb_typeof(trigger.filters -> 'payload_contains') = 'object'
        and event.payload @> (trigger.filters -> 'payload_contains')
      )
    )
    and not exists (
      select 1
      from public.ai_agent_task_trigger_firings as existing
      where existing.trigger_id = trigger.id
        and existing.source_key = 'event:' || event.id::text
    )
  order by event.created_at asc, event.id asc, trigger.id asc
  limit v_limit
  on conflict (trigger_id, source_key) do nothing;

  get diagnostics v_event_count = row_count;

  return jsonb_build_object(
    'schedule_firings', v_schedule_count,
    'business_event_firings', v_event_count
  );
end;
$$;

revoke all on function public.materialize_agent_task_trigger_firings(
  timestamptz,integer
) from public, anon, authenticated;
grant execute on function public.materialize_agent_task_trigger_firings(
  timestamptz,integer
) to service_role;

