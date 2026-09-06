-- ============================================================
-- 054_change_requests.sql — Admin change-request approval engine
--                              (Phase 3 §7)
--
-- The model is "propose then approve":
--
--   1. A trusted admin sends a WhatsApp message describing a
--      change (e.g. "set SAR/YER sell rate to 421").
--   2. The admin agent parses the intent + drafts a structured
--      `change_request` row (`status='pending'`).
--   3. The admin responds with the explicit phrase
--      "اعتماد CHG-<id> <4-digit code>" or "reject CHG-<id>".
--   4. The system records the human approval and then executes
--      the change atomically inside one transaction.
--
-- The `change_request` row carries:
--   • `proposed_payload`   — what the agent wants to do,
--   • `expected_version`    — version of the target row at
--                             proposal time (optimistic lock),
--   • `approval_id`         — FK to the matching approval row,
--   • `execution_result`    — what happened when applied.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) change_requests
-- ------------------------------------------------------------
create table if not exists public.change_requests (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id) on delete cascade,
  -- A short, human-readable code we expose back to admins in
  -- WhatsApp ("اعتماد CHG-104 4821"). Unique per account.
  code                  integer not null,
  -- 'service' | 'service_revision' | 'pricing_rule' |
  -- 'rate_book_version' | 'coverage_offer' | 'coverage_request'.
  -- Mirrors service_activity_events.target_type so the audit
  -- surface stays uniform.
  target_type           text not null,
  target_id             uuid,
  -- 'create' | 'update' | 'publish' | 'cancel' | 'archive'.
  intent                text not null
                          check (intent in ('create', 'update', 'publish', 'cancel', 'archive')),
  proposed_payload      jsonb not null default '{}'::jsonb,
  -- The version we observed on the target row at proposal time.
  -- Used at execution time for the optimistic lock — if the row
  -- has moved since the agent proposed, the executor refuses
  -- with a CONFLICT signal so the admin can re-confirm.
  expected_version      bigint,
  -- Stable hash of (target_type, target_id, intent, payload).
  -- Prevents two duplicate proposals from the same message +
  -- replay from creating parallel change requests.
  idempotency_key       text not null,
  -- 'pending' | 'approved' | 'rejected' | 'expired' |
  -- 'executed' | 'failed' | 'cancelled'.
  status                text not null default 'pending'
                          check (status in (
                            'pending', 'approved', 'rejected',
                            'expired', 'executed', 'failed', 'cancelled'
                          )),
  -- Short code shown back to the admin ("اعتماد CHG-104 4821").
  -- Generated server-side as the last 4 digits of SHA-256 of the
  -- idempotency_key; we never store the confirmation phrase
  -- itself.
  confirmation_code     text not null,
  -- Free-text summary shown in the WhatsApp reply. Rendered by
  -- the agent BEFORE the proposal is sent; admin reviews it.
  summary               text,
  expires_at            timestamptz not null default (now() + interval '24 hours'),
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  approved_by           uuid references auth.users(id) on delete set null,
  approved_at           timestamptz,
  rejected_by           uuid references auth.users(id) on delete set null,
  rejected_at           timestamptz,
  executed_at           timestamptz,
  -- What happened when applied — same JSON shape we hand back
  -- to the admin over WhatsApp.
  execution_result      jsonb,
  -- Error code if execution failed (no secrets).
  error_code            text
);

create unique index if not exists change_requests_account_code_uidx
  on public.change_requests (account_id, code);

create unique index if not exists change_requests_account_idempotency_uidx
  on public.change_requests (account_id, idempotency_key);

create index if not exists change_requests_account_status_idx
  on public.change_requests (account_id, status, created_at desc);

create index if not exists change_requests_expires_idx
  on public.change_requests (expires_at)
  where status = 'pending';

alter table public.change_requests enable row level security;

-- Reads: admin+ of the account.
drop policy if exists change_requests_select on public.change_requests;
create policy change_requests_select on public.change_requests for select
  using (is_account_member(account_id, 'admin'));

-- Writes: NONE from clients. All mutations happen via SECURITY
-- DEFINER RPCs (defined below) so the agent never holds direct
-- write access.

-- ------------------------------------------------------------
-- 2) create_change_request — service-role RPC
-- ------------------------------------------------------------
-- Validates inputs, computes the next per-account code, derives
-- the confirmation code, and inserts the row. Idempotent on
-- `idempotency_key` — if a duplicate key hits, the existing row
-- is returned (no error).
create or replace function public.create_change_request(
  p_account_id       uuid,
  p_target_type      text,
  p_target_id        uuid,
  p_intent           text,
  p_proposed_payload jsonb,
  p_expected_version bigint,
  p_idempotency_key  text,
  p_summary          text,
  p_actor_user_id    uuid
) returns table (
  id uuid,
  code integer,
  confirmation_code text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_code integer;
  v_idem_hash text;
  v_existing record;
  v_id uuid;
begin
  if p_intent not in ('create','update','publish','cancel','archive') then
    raise exception 'CHANGE_REQUEST_INVALID_INTENT'
      using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 16 then
    raise exception 'CHANGE_REQUEST_INVALID_IDEMPOTENCY_KEY'
      using errcode = 'P0001';
  end if;

  -- Idempotency: if a row with this key already exists, return it.
  select cr.id, cr.code, cr.confirmation_code, cr.status
    into v_existing
    from public.change_requests cr
   where cr.account_id = p_account_id
     and cr.idempotency_key = p_idempotency_key;
  if found then
    id := v_existing.id;
    code := v_existing.code;
    confirmation_code := v_existing.confirmation_code;
    status := v_existing.status;
    return next;
    return;
  end if;

  -- Compute next per-account code. The +1 below is safe under
  -- concurrent inserts because of the unique (account_id, code)
  -- index — a duplicate here triggers a retry.
  select coalesce(max(code), 0) + 1 into v_next_code
    from public.change_requests
   where account_id = p_account_id;

  -- 4-digit confirmation code, derived deterministically from
  -- the idempotency key so the same proposal always produces the
  -- same code (lets us surface "did the admin confirm the right
  -- request?").
  v_idem_hash := encode(digest(p_idempotency_key, 'sha256'), 'hex');
  confirmation_code := substring(v_idem_hash, 1, 4);

  begin
    insert into public.change_requests (
      account_id, code, target_type, target_id, intent,
      proposed_payload, expected_version, idempotency_key,
      status, confirmation_code, summary,
      created_by
    ) values (
      p_account_id, v_next_code, p_target_type, p_target_id, p_intent,
      coalesce(p_proposed_payload, '{}'::jsonb),
      p_expected_version, p_idempotency_key,
      'pending', confirmation_code, p_summary,
      p_actor_user_id
    )
    returning id into v_id;
  exception when unique_violation then
    -- Lost a race on (account_id, code) — retry once.
    select coalesce(max(code), 0) + 1 into v_next_code
      from public.change_requests
     where account_id = p_account_id;
    insert into public.change_requests (
      account_id, code, target_type, target_id, intent,
      proposed_payload, expected_version, idempotency_key,
      status, confirmation_code, summary,
      created_by
    ) values (
      p_account_id, v_next_code, p_target_type, p_target_id, p_intent,
      coalesce(p_proposed_payload, '{}'::jsonb),
      p_expected_version, p_idempotency_key,
      'pending', confirmation_code, p_summary,
      p_actor_user_id
    )
    returning id into v_id;
  end;

  id := v_id;
  code := v_next_code;
  status := 'pending';

  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_id,
    'change_request.created',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object(
      'code', v_next_code,
      'target_type', p_target_type,
      'intent', p_intent
    )
  );

  return next;
  return;
end;
$$;

revoke all on function public.create_change_request(
  uuid, text, uuid, text, jsonb, bigint, text, text, uuid
) from public;
grant execute on function public.create_change_request(
  uuid, text, uuid, text, jsonb, bigint, text, text, uuid
) to service_role;

-- ------------------------------------------------------------
-- 3) approve_change_request — record explicit approval
-- ------------------------------------------------------------
-- Marks the request `approved` (idempotent — repeated approvals
-- are no-ops; mismatched confirmation codes are rejected). The
-- actual execution happens in a separate RPC so the dispatcher
-- can decide WHEN to apply (typically right after the approval).
create or replace function public.approve_change_request(
  p_account_id        uuid,
  p_change_request_id uuid,
  p_confirmation_code text,
  p_actor_user_id     uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
begin
  select * into v_row
    from public.change_requests
   where id = p_change_request_id
     and account_id = p_account_id;
  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_row.status not in ('pending', 'approved') then
    -- Anything else (rejected / expired / executed / failed /
    -- cancelled) refuses with a typed error.
    raise exception 'CHANGE_REQUEST_NOT_PENDING'
      using errcode = 'P0001';
  end if;
  if v_row.expires_at < now() then
    -- Mark it expired if not already, then refuse.
    update public.change_requests
       set status = 'expired'
     where id = v_row.id
       and status in ('pending', 'approved');
    raise exception 'CHANGE_REQUEST_EXPIRED'
      using errcode = 'P0001';
  end if;
  if v_row.confirmation_code <> p_confirmation_code then
    raise exception 'CHANGE_REQUEST_BAD_CODE'
      using errcode = 'P0001';
  end if;
  if v_row.status = 'approved' then
    -- Idempotent re-approval.
    return 'approved';
  end if;
  update public.change_requests
     set status = 'approved',
         approved_at = now(),
         approved_by = p_actor_user_id
   where id = v_row.id;
  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.approved',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('code', v_row.code)
  );
  return 'approved';
end;
$$;

revoke all on function public.approve_change_request(
  uuid, uuid, text, uuid
) from public;
grant execute on function public.approve_change_request(
  uuid, uuid, text, uuid
) to service_role;

-- ------------------------------------------------------------
-- 4) reject_change_request
-- ------------------------------------------------------------
create or replace function public.reject_change_request(
  p_account_id        uuid,
  p_change_request_id uuid,
  p_actor_user_id     uuid,
  p_reason            text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
begin
  select * into v_row
    from public.change_requests
   where id = p_change_request_id
     and account_id = p_account_id;
  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'CHANGE_REQUEST_NOT_PENDING'
      using errcode = 'P0001';
  end if;
  update public.change_requests
     set status = 'rejected',
         rejected_at = now(),
         rejected_by = p_actor_user_id,
         summary = coalesce(p_reason, summary)
   where id = v_row.id;
  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.rejected',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('code', v_row.code, 'reason', p_reason)
  );
  return 'rejected';
end;
$$;

revoke all on function public.reject_change_request(
  uuid, uuid, uuid, text
) from public;
grant execute on function public.reject_change_request(
  uuid, uuid, uuid, text
) to service_role;

-- ------------------------------------------------------------
-- 5) cancel_change_request — admin cancels a still-pending one
-- ------------------------------------------------------------
create or replace function public.cancel_change_request(
  p_account_id        uuid,
  p_change_request_id uuid,
  p_actor_user_id     uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
begin
  select * into v_row
    from public.change_requests
   where id = p_change_request_id
     and account_id = p_account_id;
  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'CHANGE_REQUEST_NOT_PENDING'
      using errcode = 'P0001';
  end if;
  update public.change_requests
     set status = 'cancelled'
   where id = v_row.id;
  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.cancelled',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('code', v_row.code)
  );
  return 'cancelled';
end;
$$;

revoke all on function public.cancel_change_request(
  uuid, uuid, uuid
) from public;
grant execute on function public.cancel_change_request(
  uuid, uuid, uuid
) to service_role;
