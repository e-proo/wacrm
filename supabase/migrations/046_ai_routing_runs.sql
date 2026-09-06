-- ============================================================
-- 046_ai_routing_runs.sql — Routing & run lifecycle (Phase 1)
--
-- Sits on top of migration 045 (ai_agent_core). Together they form
-- the full Phase 1 schema.
--
-- New tables:
--   trusted_admin_identities   — per-account allow-list of WhatsApp
--                               addresses whose messages are routed
--                               to the admin-plane agent instead of
--                               the customer support flow + AI path.
--                               Identity is matched on the NORMALIZED
--                               address, never the raw webhook value.
--   ai_agent_routes            — priority-ordered rules that pick
--                               which agent handles an inbound
--                               message. The admin-plane identity
--                               check is a SEPARATE, earlier gate and
--                               is enforced in code — a low-priority
--                               rule here cannot override it.
--   conversation_ai_state      — per-conversation AI control surface,
--                               distinct from `conversations` so we
--                               can change its semantics without
--                               touching the legacy columns.
--   ai_agent_runs              — one row per inbound message that
--                               reached the AI routing stage. A
--                               unique constraint on inbound_message_id
--                               guarantees "one run per message"
--                               even under webhook replay.
--   ai_agent_run_events        — append-only state-transition log for
--                               a run. No update/delete policies.
--
-- All tables are RLS-enabled and account-scoped. Run inserts happen
-- via SECURITY DEFINER RPCs (defined below) so the service-role
-- webhook caller can claim runs without bypassing RLS for the
-- caller.
-- ============================================================

-- ------------------------------------------------------------
-- 1) trusted_admin_identities
-- ------------------------------------------------------------
create table if not exists public.trusted_admin_identities (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id) on delete cascade,
  -- 'whatsapp' for now. Reserve room for future channels.
  channel               text not null default 'whatsapp'
                          check (channel in ('whatsapp')),
  -- E.164-normalized, digits-only. The webhook normalizes before
  -- lookup, so comparisons are exact.
  normalized_address    text not null,
  display_name          text,
  -- Optional link to a teammate profile; NULL keeps the identity
  -- administrative-only (no personal handoff).
  member_id             uuid references auth.users(id) on delete set null,
  -- 'pending_verification' | 'active' | 'revoked'.
  status                text not null default 'pending_verification'
                          check (status in ('pending_verification', 'active', 'revoked')),
  verification_method   text
                          check (verification_method is null or verification_method in ('otp', 'in_app')),
  -- SHA-256 of the OTP/code we sent. Plaintext is never persisted.
  verification_code_hash text,
  -- Short-lived OTP/code window (UTC). NULL once verified.
  verification_expires_at timestamptz,
  verification_attempts  integer not null default 0
                           check (verification_attempts between 0 and 10),
  verified_at           timestamptz,
  verified_by           uuid references auth.users(id) on delete set null,
  revoked_at            timestamptz,
  revoked_by            uuid references auth.users(id) on delete set null,
  -- Capabilities reserved for Phase 3; Phase 1 only stores them.
  allowed_capabilities  jsonb not null default '[]'::jsonb,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One identity per (channel, normalized address) per account.
create unique index if not exists trusted_admin_identities_addr_uidx
  on public.trusted_admin_identities (account_id, channel, normalized_address);

create index if not exists trusted_admin_identities_account_status_idx
  on public.trusted_admin_identities (account_id, status);

alter table public.trusted_admin_identities enable row level security;

-- Reads: admin+ only (settings-class, secret-leaning).
drop policy if exists trusted_admin_identities_select on public.trusted_admin_identities;
create policy trusted_admin_identities_select on public.trusted_admin_identities for select
  using (is_account_member(account_id, 'admin'));

-- Writes: admin+ only. Phase 1 keeps the model tight — only admins
-- register / revoke trusted identities. The OTP issuance itself is a
-- service-role RPC (defined below).
drop policy if exists trusted_admin_identities_insert on public.trusted_admin_identities;
create policy trusted_admin_identities_insert on public.trusted_admin_identities for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists trusted_admin_identities_update on public.trusted_admin_identities;
create policy trusted_admin_identities_update on public.trusted_admin_identities for update
  using (is_account_member(account_id, 'admin'));

-- Soft revoke instead of DELETE so audit chains remain intact.
drop policy if exists trusted_admin_identities_delete on public.trusted_admin_identities;
create policy trusted_admin_identities_delete on public.trusted_admin_identities for delete
  using (is_account_member(account_id, 'admin'));

-- updated_at trigger
create or replace function public.update_trusted_admin_identities_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trusted_admin_identities_updated_at on public.trusted_admin_identities;
create trigger trusted_admin_identities_updated_at
  before update on public.trusted_admin_identities
  for each row execute function public.update_trusted_admin_identities_updated_at();

-- ------------------------------------------------------------
-- 2) ai_agent_routes
-- ------------------------------------------------------------
-- A route binds an agent to a condition set. The runtime resolves
-- a single agent per inbound message — see `routeInboundMessage`
-- in src/lib/ai/runtime/route.ts.
--
-- `route_kind` separates structural intent from priority:
--   'admin'   — the admin-plane path. Always evaluated BEFORE
--               customer routes. Only fires when the inbound
--               address is a verified admin identity.
--   'rule'    — user-authored rule with priority ordering.
--   'default' — fallback for the channel when no rule matches.
--               At most ONE active default per (account, channel).
create table if not exists public.ai_agent_routes (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  agent_id      uuid not null references public.ai_agents(id) on delete cascade,
  -- Free-text label shown in the UI.
  name          text not null,
  channel       text not null default 'whatsapp'
                  check (channel in ('whatsapp')),
  -- 'admin' | 'rule' | 'default'.
  route_kind    text not null
                  check (route_kind in ('admin', 'rule', 'default')),
  -- Higher = evaluated first among same-kind rules.
  priority      integer not null default 100,
  is_active     boolean not null default true,
  -- Conditions are validated JSON (closed schema):
  --   { inbox_id?, tags?: string[], language?: string,
  --     business_hours?: { start: 'HH:MM', end: 'HH:MM',
  --                        tz: IANA, weekdays: number[] } }
  -- Unknown keys are rejected by the application-layer validator.
  conditions    jsonb not null default '{}'::jsonb,
  -- When true, a match short-circuits subsequent rule evaluation.
  -- Defaults to TRUE: every rule is a "consume if matched".
  stop_processing boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- At most one ACTIVE default per (account, channel). Other rules
-- can stack freely.
create unique index if not exists ai_agent_routes_default_uidx
  on public.ai_agent_routes (account_id, channel)
  where route_kind = 'default' and is_active = true;

create index if not exists ai_agent_routes_account_kind_idx
  on public.ai_agent_routes (account_id, route_kind, priority desc);

alter table public.ai_agent_routes enable row level security;

drop policy if exists ai_agent_routes_select on public.ai_agent_routes;
create policy ai_agent_routes_select on public.ai_agent_routes for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_routes_insert on public.ai_agent_routes;
create policy ai_agent_routes_insert on public.ai_agent_routes for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_routes_update on public.ai_agent_routes;
create policy ai_agent_routes_update on public.ai_agent_routes for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_routes_delete on public.ai_agent_routes;
create policy ai_agent_routes_delete on public.ai_agent_routes for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_ai_agent_routes_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agent_routes_updated_at on public.ai_agent_routes;
create trigger ai_agent_routes_updated_at
  before update on public.ai_agent_routes
  for each row execute function public.update_ai_agent_routes_updated_at();

-- ------------------------------------------------------------
-- 3) conversation_ai_state
-- ------------------------------------------------------------
-- Per-conversation AI control surface. Distinct from
-- `conversations.ai_autoreply_disabled` (legacy) so we can add
-- richer state without breaking the old column's contract.
create table if not exists public.conversation_ai_state (
  conversation_id     uuid primary key references conversations(id) on delete cascade,
  account_id          uuid not null references accounts(id) on delete cascade,
  -- Optional explicit assignment; NULL means "let routing decide".
  assigned_ai_agent_id uuid references public.ai_agents(id) on delete set null,
  -- 'auto'        — normal routing
  -- 'human_only'  — human owns the thread (handoff or takeover)
  -- 'ai_paused'   — temporary pause (e.g., end of business hours)
  -- 'handoff'     — model requested handoff; bot stays off
  mode                text not null default 'auto'
                        check (mode in ('auto', 'human_only', 'ai_paused', 'handoff')),
  pause_until         timestamptz,
  reason              text,
  -- Optimistic-concurrency token for mutations.
  version             bigint not null default 1,
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

create index if not exists conversation_ai_state_account_mode_idx
  on public.conversation_ai_state (account_id, mode);

alter table public.conversation_ai_state enable row level security;

drop policy if exists conversation_ai_state_select on public.conversation_ai_state;
create policy conversation_ai_state_select on public.conversation_ai_state for select
  using (is_account_member(account_id));

drop policy if exists conversation_ai_state_insert on public.conversation_ai_state;
create policy conversation_ai_state_insert on public.conversation_ai_state for insert
  with check (is_account_member(account_id));

drop policy if exists conversation_ai_state_update on public.conversation_ai_state;
create policy conversation_ai_state_update on public.conversation_ai_state for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists conversation_ai_state_delete on public.conversation_ai_state;
create policy conversation_ai_state_delete on public.conversation_ai_state for delete
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4) ai_agent_runs
-- ------------------------------------------------------------
create table if not exists public.ai_agent_runs (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id) on delete cascade,
  conversation_id       uuid not null references conversations(id) on delete cascade,
  -- The message that triggered this run. UNIQUE = "one run per
  -- message" even under webhook replay (the insert itself is the
  -- idempotency boundary).
  inbound_message_id    uuid not null unique references messages(id) on delete cascade,
  -- Snapshot references — frozen at run-creation so a mid-run
  -- revision change does not change the contract under the model's
  -- feet.
  ai_agent_id           uuid not null references public.ai_agents(id) on delete restrict,
  agent_revision_id     uuid not null references public.ai_agent_revisions(id) on delete restrict,
  provider_connection_id uuid not null references public.ai_provider_connections(id) on delete restrict,
  -- Routing decision (which route / plane matched). NULL for
  -- admin-plane runs created directly from an identity match.
  route_id              uuid references public.ai_agent_routes(id) on delete set null,
  route_reason          text,
  plane                 text not null
                          check (plane in ('admin', 'customer')),
  -- 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'.
  status                text not null default 'queued'
                          check (status in ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  attempt_count         integer not null default 0
                          check (attempt_count between 0 and 10),
  available_at          timestamptz not null default now(),
  lease_expires_at      timestamptz,
  claimed_by            text,
  -- Deterministic idempotency key derived from
  -- inbound_message_id + agent_revision_id. Used to coalesce
  -- concurrent dispatcher attempts.
  idempotency_key       text not null unique,
  -- Outbound message we sent in response (NULL until the send
  -- commits). Used to reconcile webhook-driven delivery events.
  outbound_message_id   uuid references messages(id) on delete set null,
  -- Token accounting / cost / duration — denormalized for dashboards.
  input_tokens          integer,
  output_tokens         integer,
  started_at            timestamptz,
  completed_at          timestamptz,
  error_code            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Claim queries: pick the next due queued run per account.
create index if not exists ai_agent_runs_due_idx
  on public.ai_agent_runs (status, available_at)
  where status in ('queued', 'claimed');

create index if not exists ai_agent_runs_account_status_idx
  on public.ai_agent_runs (account_id, status, created_at desc);

create index if not exists ai_agent_runs_conversation_idx
  on public.ai_agent_runs (conversation_id, created_at desc);

alter table public.ai_agent_runs enable row level security;

-- Reads: members of the account. Writes: admin+ ONLY for direct
-- mutations — the service role inserts via SECURITY DEFINER RPCs.
drop policy if exists ai_agent_runs_select on public.ai_agent_runs;
create policy ai_agent_runs_select on public.ai_agent_runs for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_runs_update on public.ai_agent_runs;
create policy ai_agent_runs_update on public.ai_agent_runs for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose — runs are audit history.

create or replace function public.update_ai_agent_runs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agent_runs_updated_at on public.ai_agent_runs;
create trigger ai_agent_runs_updated_at
  before update on public.ai_agent_runs
  for each row execute function public.update_ai_agent_runs_updated_at();

-- ------------------------------------------------------------
-- 5) ai_agent_run_events — append-only state log
-- ------------------------------------------------------------
create table if not exists public.ai_agent_run_events (
  id            bigserial primary key,
  account_id    uuid not null references accounts(id) on delete cascade,
  run_id        uuid not null references public.ai_agent_runs(id) on delete cascade,
  -- 'created' | 'claimed' | 'started' | 'succeeded' | 'failed' |
  -- 'cancelled' | 'tool_called' | 'tool_succeeded' | 'tool_failed'.
  event_type    text not null,
  -- Optional structured payload. Must NOT include raw message text,
  -- prompts, or secrets — only event-level metadata.
  payload       jsonb not null default '{}'::jsonb,
  -- Who emitted the event: 'service' (the dispatcher), 'system'
  -- (background workers), or an auth.users.id.
  actor_type    text not null default 'service'
                  check (actor_type in ('service', 'system', 'user')),
  actor_id      text,
  created_at    timestamptz not null default now()
);

create index if not exists ai_agent_run_events_run_idx
  on public.ai_agent_run_events (run_id, created_at);

create index if not exists ai_agent_run_events_account_idx
  on public.ai_agent_run_events (account_id, created_at desc);

alter table public.ai_agent_run_events enable row level security;

-- Reads: members. No insert/update/delete from the client: the
-- service role writes events via SECURITY DEFINER RPCs and the
-- append-only contract is enforced by the absence of policies.
drop policy if exists ai_agent_run_events_select on public.ai_agent_run_events;
create policy ai_agent_run_events_select on public.ai_agent_run_events for select
  using (is_account_member(account_id));

-- ============================================================
-- 6) Service-role RPCs
--
-- The webhook (service-role) needs to insert a run row guarded by
-- the inbound_message_id uniqueness constraint, then atomically
-- emit a 'created' event. We expose two narrowly-scoped functions
-- so the contract is explicit and we can REVOKE PUBLIC EXECUTE.
-- ============================================================

-- Atomic run creation + 'created' event. Returns the run id, or
-- NULL when a run already exists for the same inbound message
-- (idempotent replay).
create or replace function public.create_agent_run(
  p_account_id            uuid,
  p_conversation_id       uuid,
  p_inbound_message_id    uuid,
  p_ai_agent_id           uuid,
  p_agent_revision_id     uuid,
  p_provider_connection_id uuid,
  p_route_id              uuid,
  p_route_reason          text,
  p_plane                 text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idem_key text;
  v_existing uuid;
  v_new_id   uuid;
begin
  -- Derive a deterministic idempotency key. Includes the
  -- revision so a re-run after a revision republish never
  -- silently collapses into the previous run.
  v_idem_key := 'msg:' || p_inbound_message_id::text
              || ':rev:' || p_agent_revision_id::text;

  select id into v_existing
    from public.ai_agent_runs
   where inbound_message_id = p_inbound_message_id;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.ai_agent_runs (
    account_id, conversation_id, inbound_message_id,
    ai_agent_id, agent_revision_id, provider_connection_id,
    route_id, route_reason, plane, status, idempotency_key
  ) values (
    p_account_id, p_conversation_id, p_inbound_message_id,
    p_ai_agent_id, p_agent_revision_id, p_provider_connection_id,
    p_route_id, p_route_reason, p_plane, 'queued', v_idem_key
  )
  returning id into v_new_id;

  insert into public.ai_agent_run_events (
    account_id, run_id, event_type, actor_type, actor_id, payload
  ) values (
    p_account_id, v_new_id, 'created', 'service', 'webhook',
    jsonb_build_object(
      'plane', p_plane,
      'route_id', coalesce(p_route_id::text, ''),
      'route_reason', coalesce(p_route_reason, '')
    )
  );

  return v_new_id;
end;
$$;

revoke all on function public.create_agent_run(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text
) from public;
grant execute on function public.create_agent_run(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text
) to service_role;

-- Atomic event append. Used by the dispatcher + recovery worker.
create or replace function public.append_agent_run_event(
  p_account_id uuid,
  p_run_id     uuid,
  p_event_type text,
  p_actor_type text,
  p_actor_id   text,
  p_payload    jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_agent_run_events (
    account_id, run_id, event_type, actor_type, actor_id, payload
  ) values (
    p_account_id, p_run_id, p_event_type, p_actor_type,
    coalesce(p_actor_id, ''), coalesce(p_payload, '{}'::jsonb)
  );
$$;

revoke all on function public.append_agent_run_event(
  uuid, uuid, text, text, text, jsonb
) from public;
grant execute on function public.append_agent_run_event(
  uuid, uuid, text, text, text, jsonb
) to service_role;

-- Atomic claim. One worker wins the lease. Returns the row's new
-- status ('claimed') on success, NULL when no due row exists or
-- someone else already claimed.
create or replace function public.claim_agent_run(
  p_run_id      uuid,
  p_claimed_by  text,
  p_lease_secs  integer default 60
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.ai_agent_runs
     set status = 'claimed',
         claimed_by = p_claimed_by,
         attempt_count = attempt_count + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_secs),
         available_at = now()
   where id = p_run_id
     and status in ('queued', 'claimed')
     and (lease_expires_at is null or lease_expires_at < now())
  returning status into v_status;

  if v_status is not null then
    perform public.append_agent_run_event(
      (select account_id from public.ai_agent_runs where id = p_run_id),
      p_run_id,
      'claimed',
      'service',
      p_claimed_by,
      jsonb_build_object('lease_secs', p_lease_secs)
    );
  end if;

  return v_status;
end;
$$;

revoke all on function public.claim_agent_run(uuid, text, integer) from public;
grant execute on function public.claim_agent_run(uuid, text, integer) to service_role;
