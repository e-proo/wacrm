-- ============================================================
-- 065_ai_runtime_security_and_reliability.sql
-- Security/reliability hardening for the multi-agent runtime.
-- Base commit: 13f83ecd386fe8d712bd7589df94da2537c7805e
-- ============================================================

-- -----------------------------------------------------------------
-- 1) Per-account runtime switches/budgets. Service-role runtime reads
--    this row before model/tool execution; admins may configure it.
-- -----------------------------------------------------------------
create table if not exists public.ai_runtime_policies (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  multi_agent_enabled boolean not null default false,
  admin_plane_enabled boolean not null default false,
  native_tools_enabled boolean not null default false,
  proposal_tools_enabled boolean not null default false,
  recovery_worker_enabled boolean not null default false,
  kill_switch boolean not null default false,
  max_runs_per_minute integer not null default 30 check (max_runs_per_minute between 1 and 1000),
  daily_input_token_budget bigint check (daily_input_token_budget is null or daily_input_token_budget >= 0),
  daily_output_token_budget bigint check (daily_output_token_budget is null or daily_output_token_budget >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.ai_runtime_policies enable row level security;
drop policy if exists ai_runtime_policies_select on public.ai_runtime_policies;
create policy ai_runtime_policies_select on public.ai_runtime_policies for select
  using (is_account_member(account_id, 'admin'));
drop policy if exists ai_runtime_policies_insert on public.ai_runtime_policies;
create policy ai_runtime_policies_insert on public.ai_runtime_policies for insert
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_runtime_policies_update on public.ai_runtime_policies;
create policy ai_runtime_policies_update on public.ai_runtime_policies for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

-- -----------------------------------------------------------------
-- 2) Published agent revisions and their grants are immutable to
--    direct client UPDATE/DELETE. Publishing is performed by the
--    SECURITY DEFINER function below after an explicit admin check.
-- -----------------------------------------------------------------
drop policy if exists ai_agent_revisions_update on public.ai_agent_revisions;
create policy ai_agent_revisions_update on public.ai_agent_revisions for update
  using (is_account_member(account_id, 'admin') and status = 'draft')
  with check (is_account_member(account_id, 'admin') and status = 'draft');

drop policy if exists ai_agent_tool_grants_insert on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_insert on public.ai_agent_tool_grants for insert
  with check (
    is_account_member(account_id, 'admin')
    and exists (
      select 1 from public.ai_agent_revisions r
      where r.id = agent_revision_id
        and r.account_id = ai_agent_tool_grants.account_id
        and r.status = 'draft'
    )
  );

drop policy if exists ai_agent_tool_grants_update on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_update on public.ai_agent_tool_grants for update
  using (
    is_account_member(account_id, 'admin')
    and exists (
      select 1 from public.ai_agent_revisions r
      where r.id = agent_revision_id
        and r.account_id = ai_agent_tool_grants.account_id
        and r.status = 'draft'
    )
  )
  with check (
    is_account_member(account_id, 'admin')
    and exists (
      select 1 from public.ai_agent_revisions r
      where r.id = agent_revision_id
        and r.account_id = ai_agent_tool_grants.account_id
        and r.status = 'draft'
    )
  );

drop policy if exists ai_agent_tool_grants_delete on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_delete on public.ai_agent_tool_grants for delete
  using (
    is_account_member(account_id, 'admin')
    and exists (
      select 1 from public.ai_agent_revisions r
      where r.id = agent_revision_id
        and r.account_id = ai_agent_tool_grants.account_id
        and r.status = 'draft'
    )
  );

-- Atomic publish: lock agent + target revision, inherit KB when the draft
-- has not explicitly initialized it, supersede the old revision, publish
-- the target, then move the pointer/version in ONE database transaction.
create or replace function public.publish_ai_agent_revision_atomic(
  p_account_id uuid,
  p_agent_id uuid,
  p_revision_id uuid,
  p_expected_agent_version bigint,
  p_actor_user_id uuid
) returns public.ai_agents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.ai_agents%rowtype;
  v_revision public.ai_agent_revisions%rowtype;
  v_previous_id uuid;
  v_kb_initialized boolean;
  v_connection_status text;
  v_result public.ai_agents%rowtype;
begin
  if not is_account_member(p_account_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_agent
    from public.ai_agents
   where id = p_agent_id and account_id = p_account_id
   for update;
  if not found then raise exception 'AGENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_agent.version <> p_expected_agent_version then
    raise exception 'AGENT_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if v_agent.status = 'archived' then
    raise exception 'AGENT_ARCHIVED' using errcode = 'P0001';
  end if;

  select * into v_revision
    from public.ai_agent_revisions
   where id = p_revision_id
     and account_id = p_account_id
     and agent_id = p_agent_id
   for update;
  if not found then raise exception 'REVISION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_revision.status <> 'draft' then
    raise exception 'REVISION_NOT_DRAFT' using errcode = 'P0001';
  end if;

  -- Provider binding is part of the published snapshot. Refuse to publish
  -- a revision whose connection belongs to another account or is not live.
  select status into v_connection_status
    from public.ai_provider_connections
   where id = v_revision.provider_connection_id
     and account_id = p_account_id
   for share;
  if not found then
    raise exception 'CONNECTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_connection_status not in ('active', 'verified') then
    raise exception 'CONNECTION_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  v_previous_id := v_agent.published_revision_id;
  v_kb_initialized := coalesce((v_revision.settings->>'kb_assignments_initialized')::boolean, false);

  if v_previous_id is not null
     and v_previous_id <> p_revision_id
     and not v_kb_initialized
     and not exists (
       select 1 from public.ai_agent_knowledge_assignments
        where account_id = p_account_id and agent_revision_id = p_revision_id
     ) then
    insert into public.ai_agent_knowledge_assignments (
      account_id, agent_revision_id, knowledge_chunk_id, priority, enabled
    )
    select p_account_id, p_revision_id, knowledge_chunk_id, priority, enabled
      from public.ai_agent_knowledge_assignments
     where account_id = p_account_id and agent_revision_id = v_previous_id
    on conflict (agent_revision_id, knowledge_chunk_id) do nothing;
  end if;

  if v_previous_id is not null and v_previous_id <> p_revision_id then
    update public.ai_agent_revisions
       set status = 'superseded'
     where id = v_previous_id
       and account_id = p_account_id
       and agent_id = p_agent_id
       and status = 'published';
  end if;

  update public.ai_agent_revisions
     set status = 'published', published_at = now(), published_by = p_actor_user_id
   where id = p_revision_id
     and account_id = p_account_id
     and agent_id = p_agent_id
     and status = 'draft';
  if not found then raise exception 'PUBLISH_CONFLICT' using errcode = '40001'; end if;

  update public.ai_agents
     set published_revision_id = p_revision_id,
         status = case when status = 'draft' then 'active' else status end,
         version = version + 1,
         updated_by = p_actor_user_id
   where id = p_agent_id
     and account_id = p_account_id
     and version = p_expected_agent_version
  returning * into v_result;
  if not found then raise exception 'AGENT_VERSION_CONFLICT' using errcode = '40001'; end if;

  return v_result;
end;
$$;
revoke all on function public.publish_ai_agent_revision_atomic(uuid, uuid, uuid, bigint, uuid) from public;
grant execute on function public.publish_ai_agent_revision_atomic(uuid, uuid, uuid, bigint, uuid)
  to authenticated, service_role;

-- -----------------------------------------------------------------
-- 3) Trusted-admin rows cannot be directly promoted or granted powers.
--    Client UPDATE is limited to harmless profile fields while pending;
--    activation/revoke/capability mutation goes through named RPCs.
-- -----------------------------------------------------------------
drop policy if exists trusted_admin_identities_insert on public.trusted_admin_identities;
drop policy if exists trusted_admin_identities_update on public.trusted_admin_identities;
drop policy if exists trusted_admin_identities_delete on public.trusted_admin_identities;

-- Registration/verification/revoke use server RPC/service-role paths.
-- Admins may still read through the existing select policy.

create or replace function public.set_trusted_admin_capabilities(
  p_account_id uuid,
  p_identity_id uuid,
  p_capabilities jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caps jsonb;
begin
  if not is_account_member(p_account_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_capabilities, '[]'::jsonb)) <> 'array' then
    raise exception 'capabilities must be an array' using errcode = '22023';
  end if;
  -- Only closed, server-known capability strings are accepted.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_capabilities, '[]'::jsonb)) c(v)
    where v not in (
      'services.read','services.propose','pricing.read','pricing.propose',
      'rates.read','rates.propose','coverage.read','coverage.propose',
      'intents.read','intents.propose','change_requests.read','change_requests.approve'
    )
  ) then
    raise exception 'unknown capability' using errcode = '22023';
  end if;
  update public.trusted_admin_identities
     set allowed_capabilities = coalesce(p_capabilities, '[]'::jsonb)
   where id = p_identity_id and account_id = p_account_id and status = 'active'
  returning allowed_capabilities into v_caps;
  if not found then raise exception 'identity not active' using errcode = 'P0002'; end if;
  return v_caps;
end;
$$;
revoke all on function public.set_trusted_admin_capabilities(uuid, uuid, jsonb) from public;
grant execute on function public.set_trusted_admin_capabilities(uuid, uuid, jsonb)
  to authenticated, service_role;

-- Atomic OTP verification. Wrong attempts must commit, so mismatch/expiry
-- are returned as stable status strings instead of raising exceptions (which
-- would roll the attempt increment back with the transaction).
create or replace function public.verify_trusted_admin_otp_v2(
  p_account_id uuid,
  p_identity_id uuid,
  p_otp text,
  p_actor_user_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.trusted_admin_identities%rowtype;
  v_hash text;
begin
  select * into v_row
    from public.trusted_admin_identities
   where id = p_identity_id and account_id = p_account_id
   for update;
  if not found then return 'not_found'; end if;
  if v_row.status = 'active' then return 'active'; end if;
  if v_row.status = 'revoked' then return 'revoked'; end if;
  if v_row.verification_code_hash is null or v_row.verification_expires_at is null then
    return 'no_pending';
  end if;
  if v_row.verification_expires_at < now() then return 'expired'; end if;
  if v_row.verification_attempts >= 5 then return 'locked'; end if;
  if p_otp is null or p_otp !~ '^\d{6}$' then
    update public.trusted_admin_identities
       set verification_attempts = least(verification_attempts + 1, 10)
     where id = v_row.id;
    return 'mismatch';
  end if;

  v_hash := encode(digest(p_otp, 'sha256'), 'hex');
  if v_hash <> v_row.verification_code_hash then
    update public.trusted_admin_identities
       set verification_attempts = least(verification_attempts + 1, 10)
     where id = v_row.id;
    return 'mismatch';
  end if;

  update public.trusted_admin_identities
     set status = 'active',
         verified_at = now(),
         verified_by = p_actor_user_id,
         verification_code_hash = null,
         verification_expires_at = null,
         verification_attempts = 0,
         revoked_at = null,
         revoked_by = null
   where id = v_row.id and status = 'pending_verification';
  if not found then return 'conflict'; end if;
  return 'active';
end;
$$;
revoke all on function public.verify_trusted_admin_otp_v2(uuid,uuid,text,uuid) from public;
grant execute on function public.verify_trusted_admin_otp_v2(uuid,uuid,text,uuid) to service_role;

-- -----------------------------------------------------------------
-- 4) Exact linkage from an AI run to the local outbound message.
--    The Meta wamid stays in messages.message_id (TEXT); the run FK stores
--    messages.id (UUID), matching the schema contract.
-- -----------------------------------------------------------------
alter table public.messages
  add column if not exists ai_agent_run_id uuid references public.ai_agent_runs(id) on delete set null;
create unique index if not exists messages_ai_agent_run_uidx
  on public.messages(ai_agent_run_id) where ai_agent_run_id is not null;

-- -----------------------------------------------------------------
-- 5) Change-request hardening: hashed numeric PIN, immutable content
--    digest, approver identity, attempts, and CAS execution claim.
-- -----------------------------------------------------------------
alter table public.change_requests
  add column if not exists confirmation_code_hash text,
  add column if not exists content_digest text,
  add column if not exists approval_attempts integer not null default 0,
  add column if not exists approved_identity_id uuid references public.trusted_admin_identities(id) on delete set null,
  add column if not exists approved_message_id uuid references public.messages(id) on delete set null,
  add column if not exists approved_run_id uuid references public.ai_agent_runs(id) on delete set null,
  add column if not exists executing_started_at timestamptz,
  add column if not exists execution_claim_token uuid;

-- Preserve existing pending requests without exposing old codes in list APIs.
update public.change_requests
   set confirmation_code_hash = crypt(confirmation_code, gen_salt('bf', 8))
 where confirmation_code_hash is null and confirmation_code is not null;
update public.change_requests
   set content_digest = encode(digest(
     target_type || '|' || coalesce(target_id::text, '') || '|' || intent || '|' ||
     coalesce(proposed_payload, '{}'::jsonb)::text || '|' || coalesce(expected_version::text, ''),
     'sha256'), 'hex')
 where content_digest is null;
update public.change_requests set confirmation_code = '****' where confirmation_code <> '****';

-- Expand state machine with an explicit executing state.
alter table public.change_requests drop constraint if exists change_requests_status_check;
alter table public.change_requests add constraint change_requests_status_check
  check (status in (
    'pending','approved','executing','rejected','expired','executed','failed','cancelled'
  ));
alter table public.change_requests drop constraint if exists change_requests_approval_attempts_check;
alter table public.change_requests add constraint change_requests_approval_attempts_check
  check (approval_attempts between 0 and 10);
create index if not exists change_requests_executing_idx
  on public.change_requests(executing_started_at) where status = 'executing';

create or replace function public.create_change_request_v2(
  p_account_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_intent text,
  p_proposed_payload jsonb,
  p_expected_version bigint,
  p_idempotency_key text,
  p_summary text,
  p_actor_user_id uuid
) returns table(id uuid, code integer, confirmation_code text, status text, content_digest text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.change_requests%rowtype;
  v_code integer;
  v_id uuid;
  v_pin text;
  v_digest text;
  v_b0 integer;
  v_b1 integer;
begin
  if p_intent not in ('create','update','publish','cancel','archive') then
    raise exception 'CHANGE_REQUEST_INVALID_INTENT' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 16 then
    raise exception 'CHANGE_REQUEST_INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;

  select * into v_existing from public.change_requests
   where account_id = p_account_id and idempotency_key = p_idempotency_key;
  if found then
    -- Do NOT re-expose a historical PIN. Caller must create/resend through
    -- an explicit rotation path if it lost the one-time code.
    id := v_existing.id; code := v_existing.code; confirmation_code := null;
    status := v_existing.status; content_digest := v_existing.content_digest;
    return next; return;
  end if;

  -- Serialize short-code allocation per account to avoid max()+1 races.
  perform pg_advisory_xact_lock(hashtext(p_account_id::text), 65065);
  select coalesce(max(cr.code), 0) + 1 into v_code
    from public.change_requests cr where cr.account_id = p_account_id;

  v_b0 := get_byte(gen_random_bytes(2), 0);
  v_b1 := get_byte(gen_random_bytes(2), 1);
  v_pin := lpad((1000 + ((v_b0 * 256 + v_b1) % 9000))::text, 4, '0');
  v_digest := encode(digest(
    p_target_type || '|' || coalesce(p_target_id::text, '') || '|' || p_intent || '|' ||
    coalesce(p_proposed_payload, '{}'::jsonb)::text || '|' || coalesce(p_expected_version::text, ''),
    'sha256'), 'hex');

  insert into public.change_requests(
    account_id, code, target_type, target_id, intent, proposed_payload,
    expected_version, idempotency_key, status, confirmation_code,
    confirmation_code_hash, content_digest, summary, created_by
  ) values (
    p_account_id, v_code, p_target_type, p_target_id, p_intent,
    coalesce(p_proposed_payload, '{}'::jsonb), p_expected_version,
    p_idempotency_key, 'pending', '****',
    crypt(v_pin, gen_salt('bf', 8)), v_digest, p_summary, p_actor_user_id
  ) returning change_requests.id into v_id;

  id := v_id; code := v_code; confirmation_code := v_pin;
  status := 'pending'; content_digest := v_digest;
  perform public.append_service_activity_event(
    p_account_id, 'change_request', v_id, 'change_request.created',
    'user', coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('code', v_code, 'target_type', p_target_type, 'intent', p_intent, 'digest', v_digest)
  );
  return next;
end;
$$;
revoke all on function public.create_change_request_v2(uuid,text,uuid,text,jsonb,bigint,text,text,uuid) from public;
grant execute on function public.create_change_request_v2(uuid,text,uuid,text,jsonb,bigint,text,text,uuid)
  to service_role;

create or replace function public.approve_change_request_by_code_v2(
  p_account_id uuid,
  p_request_code integer,
  p_confirmation_code text,
  p_identity_id uuid,
  p_message_id uuid default null,
  p_run_id uuid default null
) returns table(id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
  v_identity public.trusted_admin_identities%rowtype;
  v_digest text;
begin
  select * into v_identity from public.trusted_admin_identities
   where id = p_identity_id and account_id = p_account_id
     and channel = 'whatsapp' and status = 'active'
   for share;
  if not found then raise exception 'TRUSTED_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if not (v_identity.allowed_capabilities ? 'change_requests.approve') then
    raise exception 'APPROVER_CAPABILITY_REQUIRED' using errcode = '42501';
  end if;

  select * into v_row from public.change_requests
   where account_id = p_account_id and code = p_request_code
   for update;
  if not found then raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_row.status <> 'pending' then
    id := v_row.id; status := v_row.status; return next; return;
  end if;
  if v_row.expires_at < now() then
    update public.change_requests set status='expired' where change_requests.id=v_row.id;
    id := v_row.id; status := 'expired'; return next; return;
  end if;
  if v_row.approval_attempts >= 5 then
    id := v_row.id; status := 'locked'; return next; return;
  end if;

  v_digest := encode(digest(
    v_row.target_type || '|' || coalesce(v_row.target_id::text, '') || '|' || v_row.intent || '|' ||
    coalesce(v_row.proposed_payload, '{}'::jsonb)::text || '|' || coalesce(v_row.expected_version::text, ''),
    'sha256'), 'hex');
  if v_digest <> v_row.content_digest then
    raise exception 'CHANGE_REQUEST_CONTENT_CHANGED' using errcode = 'P0001';
  end if;

  if v_row.confirmation_code_hash is null
     or crypt(coalesce(p_confirmation_code,''), v_row.confirmation_code_hash) <> v_row.confirmation_code_hash then
    update public.change_requests
       set approval_attempts = approval_attempts + 1
     where change_requests.id = v_row.id;
    id := v_row.id; status := 'bad_code'; return next; return;
  end if;

  update public.change_requests
     set status='approved', approved_at=now(), approved_identity_id=p_identity_id,
         approved_message_id=p_message_id, approved_run_id=p_run_id,
         approved_by=v_identity.member_id, approval_attempts=0
   where id=v_row.id and status='pending';
  perform public.append_service_activity_event(
    p_account_id, 'change_request', v_row.id, 'change_request.approved',
    'service', p_identity_id::text,
    jsonb_build_object('code', v_row.code, 'digest', v_row.content_digest)
  );
  id := v_row.id; status := 'approved'; return next;
end;
$$;
revoke all on function public.approve_change_request_by_code_v2(uuid,integer,text,uuid,uuid,uuid) from public;
grant execute on function public.approve_change_request_by_code_v2(uuid,integer,text,uuid,uuid,uuid) to service_role;

create or replace function public.approve_change_request_dashboard_v2(
  p_account_id uuid,
  p_change_request_id uuid,
  p_confirmation_code text,
  p_actor_user_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
  v_digest text;
begin
  if p_actor_user_id is null or not is_account_member(p_account_id, 'admin') then
    raise exception 'CHANGE_REQUEST_APPROVER_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_row from public.change_requests
   where id=p_change_request_id and account_id=p_account_id for update;
  if not found then raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
  if v_row.status = 'approved' then return 'approved'; end if;
  if v_row.status <> 'pending' then raise exception 'CHANGE_REQUEST_NOT_PENDING' using errcode='P0001'; end if;
  if v_row.expires_at < now() then
    update public.change_requests set status='expired' where id=v_row.id;
    raise exception 'CHANGE_REQUEST_EXPIRED' using errcode='P0001';
  end if;
  if v_row.approval_attempts >= 5 then
    raise exception 'CHANGE_REQUEST_TOO_MANY_ATTEMPTS' using errcode='P0001';
  end if;

  v_digest := encode(digest(
    v_row.target_type || '|' || coalesce(v_row.target_id::text, '') || '|' || v_row.intent || '|' ||
    coalesce(v_row.proposed_payload, '{}'::jsonb)::text || '|' || coalesce(v_row.expected_version::text, ''),
    'sha256'), 'hex');
  if v_digest <> v_row.content_digest then
    raise exception 'CHANGE_REQUEST_CONTENT_CHANGED' using errcode='P0001';
  end if;
  if v_row.confirmation_code_hash is null
     or crypt(coalesce(p_confirmation_code,''), v_row.confirmation_code_hash) <> v_row.confirmation_code_hash then
    update public.change_requests set approval_attempts=approval_attempts+1 where id=v_row.id;
    raise exception 'CHANGE_REQUEST_BAD_CODE' using errcode='P0001';
  end if;

  update public.change_requests
     set status='approved', approved_at=now(), approved_by=p_actor_user_id,
         approval_attempts=0
   where id=v_row.id and status='pending';
  perform public.append_service_activity_event(
    p_account_id,'change_request',v_row.id,'change_request.approved',
    'user',p_actor_user_id::text,jsonb_build_object('code',v_row.code,'digest',v_row.content_digest)
  );
  return 'approved';
end;
$$;
revoke all on function public.approve_change_request_dashboard_v2(uuid,uuid,text,uuid) from public;
-- Dashboard calls this through the authenticated API route using the
-- service-role client. Do not expose the SECURITY DEFINER RPC directly to
-- browser sessions: the server endpoint is the audit/actor boundary.
grant execute on function public.approve_change_request_dashboard_v2(uuid,uuid,text,uuid) to service_role;

create or replace function public.claim_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid
) returns table(
  id uuid, target_type text, target_id uuid, intent text,
  proposed_payload jsonb, expected_version bigint, content_digest text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.change_requests%rowtype;
  v_token uuid := gen_random_uuid();
  v_digest text;
begin
  select * into v_row from public.change_requests
   where id=p_change_request_id and account_id=p_account_id for update;
  if not found then raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
  if v_row.status = 'executed' then return; end if;
  if v_row.status <> 'approved' then raise exception 'CHANGE_REQUEST_NOT_APPROVED' using errcode='P0001'; end if;
  if v_row.expires_at < now() then raise exception 'CHANGE_REQUEST_EXPIRED' using errcode='P0001'; end if;

  v_digest := encode(digest(
    v_row.target_type || '|' || coalesce(v_row.target_id::text, '') || '|' || v_row.intent || '|' ||
    coalesce(v_row.proposed_payload, '{}'::jsonb)::text || '|' || coalesce(v_row.expected_version::text, ''),
    'sha256'), 'hex');
  if v_digest <> v_row.content_digest then raise exception 'CHANGE_REQUEST_CONTENT_CHANGED' using errcode='P0001'; end if;

  update public.change_requests
     set status='executing', executing_started_at=now(), execution_claim_token=v_token
   where change_requests.id=v_row.id and change_requests.status='approved';
  if not found then raise exception 'CHANGE_REQUEST_EXECUTION_RACE' using errcode='40001'; end if;

  id:=v_row.id; target_type:=v_row.target_type; target_id:=v_row.target_id;
  intent:=v_row.intent; proposed_payload:=v_row.proposed_payload;
  expected_version:=v_row.expected_version; content_digest:=v_row.content_digest;
  claim_token:=v_token; return next;
end;
$$;
revoke all on function public.claim_change_request_execution(uuid,uuid) from public;
grant execute on function public.claim_change_request_execution(uuid,uuid) to service_role;

create or replace function public.complete_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid,
  p_claim_token uuid,
  p_result jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.change_requests
     set status='executed', executed_at=now(), execution_result=coalesce(p_result,'{}'::jsonb),
         error_code=null, execution_claim_token=null
   where id=p_change_request_id and account_id=p_account_id
     and status='executing' and execution_claim_token=p_claim_token;
  return found;
end;
$$;
revoke all on function public.complete_change_request_execution(uuid,uuid,uuid,jsonb) from public;
grant execute on function public.complete_change_request_execution(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.fail_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid,
  p_claim_token uuid,
  p_error_code text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.change_requests
     set status='failed', error_code=left(coalesce(p_error_code,'EXECUTION_FAILED'),120),
         execution_claim_token=null
   where id=p_change_request_id and account_id=p_account_id
     and status='executing' and execution_claim_token=p_claim_token;
  return found;
end;
$$;
revoke all on function public.fail_change_request_execution(uuid,uuid,uuid,text) from public;
grant execute on function public.fail_change_request_execution(uuid,uuid,uuid,text) to service_role;

-- Coverage-offer creation becomes replay-safe for its current executor.
alter table public.coverage_offers
  add column if not exists source_change_request_id uuid references public.change_requests(id) on delete set null;
create unique index if not exists coverage_offers_source_change_request_uidx
  on public.coverage_offers(source_change_request_id) where source_change_request_id is not null;

-- -----------------------------------------------------------------
-- 6) Tenant-consistency constraints. Composite FKs are NOT VALID so
--    existing production rows are not blocked; new/updated rows are
--    checked immediately. Validate after auditing historical data.
-- -----------------------------------------------------------------
create unique index if not exists ai_agents_account_id_id_uidx on public.ai_agents(account_id,id);
create unique index if not exists ai_agent_revisions_account_id_id_uidx on public.ai_agent_revisions(account_id,id);
create unique index if not exists ai_provider_connections_account_id_id_uidx on public.ai_provider_connections(account_id,id);
create unique index if not exists conversations_account_id_id_uidx on public.conversations(account_id,id);

alter table public.ai_agent_revisions drop constraint if exists ai_agent_revisions_account_agent_fk;
alter table public.ai_agent_revisions add constraint ai_agent_revisions_account_agent_fk
  foreign key (account_id,agent_id) references public.ai_agents(account_id,id) not valid;
alter table public.ai_agent_tool_grants drop constraint if exists ai_agent_tool_grants_account_revision_fk;
alter table public.ai_agent_tool_grants add constraint ai_agent_tool_grants_account_revision_fk
  foreign key (account_id,agent_revision_id) references public.ai_agent_revisions(account_id,id) not valid;
alter table public.ai_agent_runs drop constraint if exists ai_agent_runs_account_agent_fk;
alter table public.ai_agent_runs add constraint ai_agent_runs_account_agent_fk
  foreign key (account_id,ai_agent_id) references public.ai_agents(account_id,id) not valid;
alter table public.ai_agent_runs drop constraint if exists ai_agent_runs_account_revision_fk;
alter table public.ai_agent_runs add constraint ai_agent_runs_account_revision_fk
  foreign key (account_id,agent_revision_id) references public.ai_agent_revisions(account_id,id) not valid;
alter table public.ai_agent_runs drop constraint if exists ai_agent_runs_account_provider_fk;
alter table public.ai_agent_runs add constraint ai_agent_runs_account_provider_fk
  foreign key (account_id,provider_connection_id) references public.ai_provider_connections(account_id,id) not valid;
alter table public.ai_agent_runs drop constraint if exists ai_agent_runs_account_conversation_fk;
alter table public.ai_agent_runs add constraint ai_agent_runs_account_conversation_fk
  foreign key (account_id,conversation_id) references public.conversations(account_id,id) not valid;


-- Broaden tenant-consistency to the route/state/knowledge/service graphs.
create unique index if not exists ai_knowledge_chunks_account_id_id_uidx
  on public.ai_knowledge_chunks(account_id,id);
create unique index if not exists ai_agent_routes_account_id_id_uidx
  on public.ai_agent_routes(account_id,id);
create unique index if not exists service_categories_account_id_id_uidx
  on public.service_categories(account_id,id);
create unique index if not exists service_category_schema_versions_account_id_id_uidx
  on public.service_category_schema_versions(account_id,id);
create unique index if not exists services_account_id_id_uidx
  on public.services(account_id,id);
create unique index if not exists service_revisions_account_id_id_uidx
  on public.service_revisions(account_id,id);
create unique index if not exists service_pricing_rules_account_id_id_uidx
  on public.service_pricing_rules(account_id,id);
create unique index if not exists contacts_account_id_id_uidx
  on public.contacts(account_id,id);

alter table public.ai_agent_routes drop constraint if exists ai_agent_routes_account_agent_fk;
alter table public.ai_agent_routes add constraint ai_agent_routes_account_agent_fk
  foreign key (account_id,agent_id) references public.ai_agents(account_id,id) not valid;
alter table public.conversation_ai_state drop constraint if exists conversation_ai_state_account_conversation_fk;
alter table public.conversation_ai_state add constraint conversation_ai_state_account_conversation_fk
  foreign key (account_id,conversation_id) references public.conversations(account_id,id) not valid;
alter table public.conversation_ai_state drop constraint if exists conversation_ai_state_account_agent_fk;
alter table public.conversation_ai_state add constraint conversation_ai_state_account_agent_fk
  foreign key (account_id,assigned_ai_agent_id) references public.ai_agents(account_id,id) not valid;
alter table public.ai_agent_knowledge_assignments drop constraint if exists ai_agent_knowledge_account_revision_fk;
alter table public.ai_agent_knowledge_assignments add constraint ai_agent_knowledge_account_revision_fk
  foreign key (account_id,agent_revision_id) references public.ai_agent_revisions(account_id,id) not valid;
alter table public.ai_agent_knowledge_assignments drop constraint if exists ai_agent_knowledge_account_chunk_fk;
alter table public.ai_agent_knowledge_assignments add constraint ai_agent_knowledge_account_chunk_fk
  foreign key (account_id,knowledge_chunk_id) references public.ai_knowledge_chunks(account_id,id) not valid;
alter table public.services drop constraint if exists services_account_category_fk;
alter table public.services add constraint services_account_category_fk
  foreign key (account_id,category_id) references public.service_categories(account_id,id) not valid;
alter table public.service_revisions drop constraint if exists service_revisions_account_service_fk;
alter table public.service_revisions add constraint service_revisions_account_service_fk
  foreign key (account_id,service_id) references public.services(account_id,id) not valid;
alter table public.service_revisions drop constraint if exists service_revisions_account_schema_fk;
alter table public.service_revisions add constraint service_revisions_account_schema_fk
  foreign key (account_id,category_schema_version_id)
  references public.service_category_schema_versions(account_id,id) not valid;
alter table public.service_revisions drop constraint if exists service_revisions_account_pricing_fk;
alter table public.service_revisions add constraint service_revisions_account_pricing_fk
  foreign key (account_id,pricing_rule_id) references public.service_pricing_rules(account_id,id) not valid;

-- -----------------------------------------------------------------
-- 7) Permanent worker primitive. One due run is claimed with
--    SKIP LOCKED; expired leases are retryable until attempt_count=10.
-- -----------------------------------------------------------------
create or replace function public.claim_next_agent_run(
  p_worker_id text,
  p_lease_secs integer default 300
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.ai_agent_runs
   where available_at <= now()
     and attempt_count < 10
     and (
       status='queued'
       or (status='claimed' and lease_expires_at < now())
     )
   order by available_at asc, created_at asc
   for update skip locked
   limit 1;
  if v_id is null then return null; end if;

  update public.ai_agent_runs
     set status='claimed', claimed_by=p_worker_id,
         attempt_count=attempt_count+1,
         lease_expires_at=now()+make_interval(secs=>p_lease_secs),
         started_at=coalesce(started_at,now())
   where id=v_id;
  perform public.append_agent_run_event(
    (select account_id from public.ai_agent_runs where id=v_id),
    v_id,'claimed','service',p_worker_id,jsonb_build_object('lease_secs',p_lease_secs)
  );
  return v_id;
end;
$$;
revoke all on function public.claim_next_agent_run(text,integer) from public;
grant execute on function public.claim_next_agent_run(text,integer) to service_role;

-- -----------------------------------------------------------------
-- 8) Atomic runtime budget reservation. Concurrent runs serialize on
--    an account advisory lock; stale reservations self-expire.
-- -----------------------------------------------------------------
create table if not exists public.ai_runtime_budget_reservations (
  run_id uuid primary key references public.ai_agent_runs(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  estimated_input_tokens integer not null default 0 check (estimated_input_tokens >= 0),
  estimated_output_tokens integer not null default 0 check (estimated_output_tokens >= 0),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now()
);
create index if not exists ai_runtime_budget_reservations_account_idx
  on public.ai_runtime_budget_reservations(account_id, expires_at);
alter table public.ai_runtime_budget_reservations enable row level security;
-- service-role only; no authenticated policies.

create or replace function public.reserve_ai_agent_runtime_budget(
  p_account_id uuid,
  p_run_id uuid,
  p_estimated_input_tokens integer,
  p_estimated_output_tokens integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy public.ai_runtime_policies%rowtype;
  v_agent_id uuid;
  v_minute_runs bigint;
  v_input bigint;
  v_output bigint;
  v_reserved_input bigint;
  v_reserved_output bigint;
  v_budget record;
  v_start timestamptz;
  v_runs bigint;
  v_agent_input bigint;
  v_agent_output bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 6501));

  select ai_agent_id into v_agent_id
    from public.ai_agent_runs
   where id=p_run_id and account_id=p_account_id;
  if not found then return 'RUN_NOT_FOUND'; end if;

  select * into v_policy from public.ai_runtime_policies where account_id=p_account_id;
  -- No account runtime-policy row keeps dangerous feature flags fail-closed in
  -- application code; existing per-agent budget policies below are still
  -- enforced if present.
  if found then
    if v_policy.kill_switch then return 'AI_KILL_SWITCH'; end if;
    if not v_policy.multi_agent_enabled then return 'MULTI_AGENT_DISABLED'; end if;

    select count(*) into v_minute_runs
      from public.ai_agent_runs
     where account_id=p_account_id and created_at >= now() - interval '1 minute';
    if v_minute_runs > v_policy.max_runs_per_minute then return 'RATE_LIMIT_EXCEEDED'; end if;

    select coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0)
      into v_input, v_output
      from public.ai_agent_runs
     where account_id=p_account_id
       and created_at >= date_trunc('day', now())
       and status in ('succeeded','failed');

    select coalesce(sum(estimated_input_tokens),0), coalesce(sum(estimated_output_tokens),0)
      into v_reserved_input, v_reserved_output
      from public.ai_runtime_budget_reservations
     where account_id=p_account_id and expires_at > now() and run_id <> p_run_id;

    if v_policy.daily_input_token_budget is not null
       and v_input + v_reserved_input + greatest(p_estimated_input_tokens,0) > v_policy.daily_input_token_budget then
      return 'DAILY_INPUT_BUDGET_EXCEEDED';
    end if;
    if v_policy.daily_output_token_budget is not null
       and v_output + v_reserved_output + greatest(p_estimated_output_tokens,0) > v_policy.daily_output_token_budget then
      return 'DAILY_OUTPUT_BUDGET_EXCEEDED';
    end if;
  end if;

  -- Enforce the policies already exposed by /api/ai-agents/[id]/budget.
  -- Agent-specific policy wins over account default (agent_id IS NULL).
  for v_budget in
    select distinct on (period)
      period, max_runs, max_input_tokens, max_output_tokens, hard_action, agent_id
      from public.ai_agent_budget_policies
     where account_id=p_account_id
       and is_active=true
       and (agent_id=v_agent_id or agent_id is null)
     order by period, (agent_id is not null) desc, updated_at desc
  loop
    v_start := case v_budget.period
      when 'monthly' then date_trunc('month', now())
      else date_trunc('day', now())
    end;

    select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0)
      into v_runs, v_agent_input, v_agent_output
      from public.ai_agent_runs
     where account_id=p_account_id
       and created_at >= v_start
       and (v_budget.agent_id is null or ai_agent_id=v_agent_id)
       and id <> p_run_id;

    if v_runs + 1 > v_budget.max_runs then
      return 'AGENT_BUDGET_RUNS_EXCEEDED:' || v_budget.hard_action;
    end if;
    if v_agent_input + greatest(p_estimated_input_tokens,0) > v_budget.max_input_tokens then
      return 'AGENT_BUDGET_INPUT_EXCEEDED:' || v_budget.hard_action;
    end if;
    if v_agent_output + greatest(p_estimated_output_tokens,0) > v_budget.max_output_tokens then
      return 'AGENT_BUDGET_OUTPUT_EXCEEDED:' || v_budget.hard_action;
    end if;
  end loop;

  insert into public.ai_runtime_budget_reservations(
    run_id, account_id, estimated_input_tokens, estimated_output_tokens, expires_at
  ) values (
    p_run_id, p_account_id, greatest(p_estimated_input_tokens,0), greatest(p_estimated_output_tokens,0), now()+interval '15 minutes'
  )
  on conflict (run_id) do update set
    estimated_input_tokens=excluded.estimated_input_tokens,
    estimated_output_tokens=excluded.estimated_output_tokens,
    expires_at=excluded.expires_at;
  return null;
end;
$$;
revoke all on function public.reserve_ai_agent_runtime_budget(uuid,uuid,integer,integer) from public;
grant execute on function public.reserve_ai_agent_runtime_budget(uuid,uuid,integer,integer) to service_role;

create or replace function public.release_ai_agent_runtime_budget(p_run_id uuid)
returns void language sql security definer set search_path=public as $$
  delete from public.ai_runtime_budget_reservations where run_id=p_run_id;
$$;
revoke all on function public.release_ai_agent_runtime_budget(uuid) from public;
grant execute on function public.release_ai_agent_runtime_budget(uuid) to service_role;
