-- ============================================================
-- 109_ai_agent_task_platform.sql
-- Agent Task / Outreach persistence foundation.
--
-- Additive only:
--   * creates durable agent tasks, task targets, and task events
--   * widens ai_agent_runs into a generic execution record
--   * preserves create_agent_run(...) unchanged for inbound compatibility
--   * adds create_agent_execution(...) for generic inbound/outbound/simulation
-- ============================================================

create unique index if not exists ai_agent_revisions_account_agent_id_uidx
  on public.ai_agent_revisions (account_id, agent_id, id);

create table if not exists public.ai_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_type text not null,
  task_type_version integer not null check (task_type_version > 0),
  agent_id uuid not null,
  agent_revision_id uuid not null,
  trigger_type text not null
    check (trigger_type in ('manual', 'scheduled', 'business_event', 'system')),
  trigger_ref text,
  status text not null default 'draft'
    check (status in (
      'draft',
      'validating',
      'scheduled',
      'queued',
      'running',
      'paused',
      'completed',
      'partially_completed',
      'failed',
      'cancelled'
    )),
  objective text not null check (length(btrim(objective)) > 0),
  task_context jsonb not null default '{}'::jsonb,
  target_policy jsonb not null default '{}'::jsonb,
  channel text not null default 'whatsapp'
    check (channel in ('whatsapp')),
  max_targets integer not null default 1
    check (max_targets between 1 and 10000),
  max_attempts_per_target integer not null default 1
    check (max_attempts_per_target between 1 and 20),
  budget_policy jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  correlation_id text not null check (length(btrim(correlation_id)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_tasks_account_agent_revision_fk
    foreign key (account_id, agent_id, agent_revision_id)
    references public.ai_agent_revisions(account_id, agent_id, id)
    on delete restrict
);

create unique index if not exists ai_agent_tasks_account_id_id_uidx
  on public.ai_agent_tasks (account_id, id);

create unique index if not exists ai_agent_tasks_account_idempotency_uidx
  on public.ai_agent_tasks (account_id, idempotency_key);

create index if not exists ai_agent_tasks_due_idx
  on public.ai_agent_tasks (status, scheduled_at)
  where status in ('scheduled', 'queued', 'running');

create index if not exists ai_agent_tasks_account_status_idx
  on public.ai_agent_tasks (account_id, status, created_at desc);

alter table public.ai_agent_tasks enable row level security;

drop policy if exists ai_agent_tasks_select on public.ai_agent_tasks;
create policy ai_agent_tasks_select on public.ai_agent_tasks
  for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_tasks_insert on public.ai_agent_tasks;
create policy ai_agent_tasks_insert on public.ai_agent_tasks
  for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_tasks_update on public.ai_agent_tasks;
create policy ai_agent_tasks_update on public.ai_agent_tasks
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

revoke all on table public.ai_agent_tasks from anon, authenticated;
grant select, insert, update on table public.ai_agent_tasks to authenticated;
grant all on table public.ai_agent_tasks to service_role;

create or replace function public.update_ai_agent_tasks_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ai_agent_tasks_updated_at on public.ai_agent_tasks;
create trigger ai_agent_tasks_updated_at
  before update on public.ai_agent_tasks
  for each row execute function public.update_ai_agent_tasks_updated_at();

create unique index if not exists contacts_account_id_id_uidx
  on public.contacts (account_id, id);

create unique index if not exists conversations_account_id_id_uidx
  on public.conversations (account_id, id);

create unique index if not exists messages_conversation_id_id_uidx
  on public.messages (conversation_id, id);

create table if not exists public.ai_agent_task_targets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_id uuid not null,
  contact_id uuid,
  entity_type text,
  entity_id uuid,
  counterparty_role text not null check (length(btrim(counterparty_role)) > 0),
  status text not null default 'candidate'
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
      'completed',
      'skipped',
      'failed',
      'opted_out',
      'exhausted'
    )),
  conversation_id uuid,
  attempt_count integer not null default 0
    check (attempt_count between 0 and 100),
  last_attempt_at timestamptz,
  next_action_at timestamptz,
  first_contacted_at timestamptz,
  replied_at timestamptz,
  completed_at timestamptz,
  last_outbound_message_id uuid,
  skip_reason text,
  failure_code text,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_task_targets_identity_check
    check (
      contact_id is not null
      or (entity_type is not null and entity_id is not null)
    ),
  constraint ai_agent_task_targets_entity_pair_check
    check ((entity_type is null) = (entity_id is null)),
  constraint ai_agent_task_targets_message_context_check
    check (last_outbound_message_id is null or conversation_id is not null),
  constraint ai_agent_task_targets_account_task_fk
    foreign key (account_id, task_id)
    references public.ai_agent_tasks(account_id, id)
    on delete restrict,
  constraint ai_agent_task_targets_account_contact_fk
    foreign key (account_id, contact_id)
    references public.contacts(account_id, id)
    on delete restrict,
  constraint ai_agent_task_targets_account_conversation_fk
    foreign key (account_id, conversation_id)
    references public.conversations(account_id, id)
    on delete restrict,
  constraint ai_agent_task_targets_conversation_message_fk
    foreign key (conversation_id, last_outbound_message_id)
    references public.messages(conversation_id, id)
    on delete set null
);

create unique index if not exists ai_agent_task_targets_account_id_id_uidx
  on public.ai_agent_task_targets (account_id, id);

create unique index if not exists ai_agent_task_targets_account_task_id_id_uidx
  on public.ai_agent_task_targets (account_id, task_id, id);

create unique index if not exists ai_agent_task_targets_account_idempotency_uidx
  on public.ai_agent_task_targets (account_id, idempotency_key);

create unique index if not exists ai_agent_task_targets_task_contact_uidx
  on public.ai_agent_task_targets (task_id, contact_id)
  where contact_id is not null;

create unique index if not exists ai_agent_task_targets_task_entity_uidx
  on public.ai_agent_task_targets (task_id, entity_type, entity_id)
  where entity_id is not null;

create index if not exists ai_agent_task_targets_due_idx
  on public.ai_agent_task_targets (status, next_action_at)
  where status in ('eligible', 'queued', 'preparing', 'sending', 'awaiting_reply', 'replied', 'in_progress');

create index if not exists ai_agent_task_targets_account_task_status_idx
  on public.ai_agent_task_targets (account_id, task_id, status);

alter table public.ai_agent_task_targets enable row level security;

drop policy if exists ai_agent_task_targets_select on public.ai_agent_task_targets;
create policy ai_agent_task_targets_select on public.ai_agent_task_targets
  for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_task_targets_insert on public.ai_agent_task_targets;
create policy ai_agent_task_targets_insert on public.ai_agent_task_targets
  for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_task_targets_update on public.ai_agent_task_targets;
create policy ai_agent_task_targets_update on public.ai_agent_task_targets
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

revoke all on table public.ai_agent_task_targets from anon, authenticated;
grant select, insert, update on table public.ai_agent_task_targets to authenticated;
grant all on table public.ai_agent_task_targets to service_role;

create or replace function public.update_ai_agent_task_targets_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ai_agent_task_targets_updated_at on public.ai_agent_task_targets;
create trigger ai_agent_task_targets_updated_at
  before update on public.ai_agent_task_targets
  for each row execute function public.update_ai_agent_task_targets_updated_at();

alter table public.ai_agent_runs
  alter column inbound_message_id drop not null,
  add column if not exists run_mode text not null default 'inbound',
  add column if not exists task_id uuid,
  add column if not exists task_target_id uuid,
  add column if not exists trigger_type text not null default 'inbound_message',
  add column if not exists trigger_ref text,
  add column if not exists counterparty_role text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_agent_runs'::regclass
      and conname = 'ai_agent_runs_mode_check'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_mode_check
      check (run_mode in ('inbound', 'outbound', 'simulation')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_agent_runs'::regclass
      and conname = 'ai_agent_runs_source_shape_check'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_source_shape_check
      check (
        (run_mode = 'inbound' and inbound_message_id is not null and task_id is null and task_target_id is null)
        or
        (run_mode = 'outbound' and inbound_message_id is null and task_id is not null and task_target_id is not null)
        or
        (run_mode = 'simulation' and inbound_message_id is null)
      ) not valid;
  end if;
end
$$;

alter table public.ai_agent_runs validate constraint ai_agent_runs_mode_check;
alter table public.ai_agent_runs validate constraint ai_agent_runs_source_shape_check;

create unique index if not exists ai_agent_runs_account_id_id_uidx
  on public.ai_agent_runs (account_id, id);

create unique index if not exists ai_agent_runs_account_task_id_id_uidx
  on public.ai_agent_runs (account_id, task_id, id);

create index if not exists ai_agent_runs_task_target_idx
  on public.ai_agent_runs (task_id, task_target_id, created_at desc)
  where task_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_agent_runs'::regclass
      and conname = 'ai_agent_runs_account_task_fk'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_account_task_fk
      foreign key (account_id, task_id)
      references public.ai_agent_tasks(account_id, id)
      on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_agent_runs'::regclass
      and conname = 'ai_agent_runs_account_task_target_fk'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_account_task_target_fk
      foreign key (account_id, task_id, task_target_id)
      references public.ai_agent_task_targets(account_id, task_id, id)
      on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_agent_runs'::regclass
      and conname = 'ai_agent_runs_account_agent_revision_identity_fk'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_account_agent_revision_identity_fk
      foreign key (account_id, ai_agent_id, agent_revision_id)
      references public.ai_agent_revisions(account_id, agent_id, id)
      on delete restrict
      not valid;
  end if;
end
$$;

alter table public.ai_agent_runs validate constraint ai_agent_runs_account_task_fk;
alter table public.ai_agent_runs validate constraint ai_agent_runs_account_task_target_fk;
alter table public.ai_agent_runs validate constraint ai_agent_runs_account_agent_revision_identity_fk;

create table if not exists public.ai_agent_task_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_id uuid not null,
  task_target_id uuid,
  run_id uuid,
  event_type text not null check (length(btrim(event_type)) > 0),
  payload jsonb not null default '{}'::jsonb,
  actor_type text not null default 'service'
    check (actor_type in ('service', 'system', 'user')),
  actor_id text,
  created_at timestamptz not null default now(),
  constraint ai_agent_task_events_account_task_fk
    foreign key (account_id, task_id)
    references public.ai_agent_tasks(account_id, id)
    on delete restrict,
  constraint ai_agent_task_events_account_target_fk
    foreign key (account_id, task_id, task_target_id)
    references public.ai_agent_task_targets(account_id, task_id, id)
    on delete restrict,
  constraint ai_agent_task_events_account_run_fk
    foreign key (account_id, task_id, run_id)
    references public.ai_agent_runs(account_id, task_id, id)
    on delete restrict
);

create index if not exists ai_agent_task_events_task_idx
  on public.ai_agent_task_events (task_id, created_at);

create index if not exists ai_agent_task_events_target_idx
  on public.ai_agent_task_events (task_target_id, created_at)
  where task_target_id is not null;

alter table public.ai_agent_task_events enable row level security;

drop policy if exists ai_agent_task_events_select on public.ai_agent_task_events;
create policy ai_agent_task_events_select on public.ai_agent_task_events
  for select
  using (is_account_member(account_id));

revoke all on table public.ai_agent_task_events from anon, authenticated;
grant select on table public.ai_agent_task_events to authenticated;
grant all on table public.ai_agent_task_events to service_role;

create or replace function public.append_agent_task_event(
  p_account_id uuid,
  p_task_id uuid,
  p_task_target_id uuid,
  p_run_id uuid,
  p_event_type text,
  p_actor_type text,
  p_actor_id text,
  p_payload jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  if length(btrim(coalesce(p_event_type, ''))) = 0 then
    raise exception 'AGENT_TASK_EVENT_TYPE_REQUIRED';
  end if;
  if p_actor_type not in ('service', 'system', 'user') then
    raise exception 'AGENT_TASK_EVENT_ACTOR_INVALID';
  end if;

  insert into public.ai_agent_task_events (
    account_id,
    task_id,
    task_target_id,
    run_id,
    event_type,
    payload,
    actor_type,
    actor_id
  ) values (
    p_account_id,
    p_task_id,
    p_task_target_id,
    p_run_id,
    p_event_type,
    coalesce(p_payload, '{}'::jsonb),
    p_actor_type,
    nullif(p_actor_id, '')
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function public.append_agent_task_event(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.append_agent_task_event(
  uuid, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;

create or replace function public.create_agent_execution(
  p_account_id uuid,
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_ai_agent_id uuid,
  p_agent_revision_id uuid,
  p_provider_connection_id uuid,
  p_route_id uuid,
  p_route_reason text,
  p_plane text,
  p_run_mode text,
  p_task_id uuid,
  p_task_target_id uuid,
  p_trigger_type text,
  p_trigger_ref text,
  p_counterparty_role text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_new_id uuid;
begin
  if p_run_mode not in ('inbound', 'outbound', 'simulation') then
    raise exception 'AGENT_EXECUTION_MODE_INVALID';
  end if;
  if p_plane not in ('admin', 'customer') then
    raise exception 'AGENT_EXECUTION_PLANE_INVALID';
  end if;
  if length(btrim(coalesce(p_idempotency_key, ''))) = 0 then
    raise exception 'AGENT_EXECUTION_IDEMPOTENCY_REQUIRED';
  end if;
  if length(btrim(coalesce(p_trigger_type, ''))) = 0 then
    raise exception 'AGENT_EXECUTION_TRIGGER_REQUIRED';
  end if;

  if p_run_mode = 'inbound' then
    if p_inbound_message_id is null or p_task_id is not null or p_task_target_id is not null then
      raise exception 'AGENT_EXECUTION_INBOUND_SOURCE_INVALID';
    end if;
    if not exists (
      select 1
      from public.messages as m
      where m.id = p_inbound_message_id
        and m.conversation_id = p_conversation_id
    ) then
      raise exception 'AGENT_EXECUTION_INBOUND_CONTEXT_MISMATCH';
    end if;
  elsif p_run_mode = 'outbound' then
    if p_inbound_message_id is not null or p_task_id is null or p_task_target_id is null then
      raise exception 'AGENT_EXECUTION_OUTBOUND_SOURCE_INVALID';
    end if;
    if not exists (
      select 1
      from public.ai_agent_task_targets as t
      where t.account_id = p_account_id
        and t.task_id = p_task_id
        and t.id = p_task_target_id
        and t.conversation_id = p_conversation_id
    ) then
      raise exception 'AGENT_EXECUTION_OUTBOUND_CONTEXT_MISMATCH';
    end if;
  else
    if p_inbound_message_id is not null then
      raise exception 'AGENT_EXECUTION_SIMULATION_SOURCE_INVALID';
    end if;
  end if;

  select id into v_existing
  from public.ai_agent_runs
  where idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  if p_inbound_message_id is not null then
    select id into v_existing
    from public.ai_agent_runs
    where inbound_message_id = p_inbound_message_id;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

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
    p_ai_agent_id,
    p_agent_revision_id,
    p_provider_connection_id,
    p_route_id,
    p_route_reason,
    p_plane,
    'queued',
    p_idempotency_key,
    p_run_mode,
    p_task_id,
    p_task_target_id,
    p_trigger_type,
    p_trigger_ref,
    p_counterparty_role
  )
  returning id into v_new_id;

  insert into public.ai_agent_run_events (
    account_id,
    run_id,
    event_type,
    actor_type,
    actor_id,
    payload
  ) values (
    p_account_id,
    v_new_id,
    'created',
    'service',
    'agent_execution',
    jsonb_build_object(
      'plane', p_plane,
      'run_mode', p_run_mode,
      'trigger_type', p_trigger_type,
      'trigger_ref', coalesce(p_trigger_ref, ''),
      'task_id', coalesce(p_task_id::text, ''),
      'task_target_id', coalesce(p_task_target_id::text, ''),
      'counterparty_role', coalesce(p_counterparty_role, ''),
      'route_id', coalesce(p_route_id::text, ''),
      'route_reason', coalesce(p_route_reason, '')
    )
  );

  return v_new_id;
end;
$$;

revoke all on function public.create_agent_execution(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text,
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_agent_execution(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text,
  uuid, uuid, text, text, text, text
) to service_role;
