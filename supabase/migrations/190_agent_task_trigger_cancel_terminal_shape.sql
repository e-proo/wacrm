-- SCH-2: terminal policy cancellation without modifying migration 125.
-- Cancel preserves future/cleared date shape and does NOT alter completed Task rows.

alter table public.ai_agent_task_triggers
  drop constraint if exists ai_agent_task_triggers_shape_check;

alter table public.ai_agent_task_triggers
  add constraint ai_agent_task_triggers_shape_check check (
    (
      trigger_kind = 'schedule'
      and schedule_kind = 'once'
      and interval_minutes is null
      and event_type is null
      and event_version is null
      and (
        (
          status in ('enabled', 'paused', 'cancelled')
          and next_fire_at is not null
        )
        or
        (
          status in ('completed', 'cancelled')
          and next_fire_at is null
        )
      )
    )
    or
    (
      trigger_kind = 'schedule'
      and schedule_kind = 'recurring'
      and next_fire_at is not null
      and interval_minutes between 5 and 525600
      and event_type is null
      and event_version is null
      and status in ('enabled', 'paused', 'cancelled')
    )
    or
    (
      trigger_kind = 'business_event'
      and schedule_kind is null
      and next_fire_at is null
      and interval_minutes is null
      and event_type is not null
      and event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      and event_version is not null
      and status in ('enabled', 'paused', 'cancelled')
    )
  );
