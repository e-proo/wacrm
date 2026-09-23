-- ============================================================
-- 103_change_request_action_identity.sql
-- Add action_key/action_version as the primary extensible dispatch identity.
--
-- target_type/target_id/intent remain legacy target metadata for compatibility.
-- New native-domain proposals dual-write the exact action contract while
-- historical rows continue to validate and execute through legacy selectors.
-- ============================================================

alter table public.change_requests
  add column if not exists action_key text,
  add column if not exists action_version integer;

alter table public.change_requests
  drop constraint if exists change_requests_action_identity_check;

alter table public.change_requests
  add constraint change_requests_action_identity_check
  check (
    (action_key is null and action_version is null)
    or (
      action_key is not null
      and action_version is not null
      and char_length(action_key) between 3 and 160
      and action_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'
      and action_version > 0
    )
  );

-- target_type is legacy target metadata, not an extensibility allow-list.
alter table public.change_requests
  drop constraint if exists change_requests_target_type_check;

alter table public.change_requests
  add constraint change_requests_target_type_check
  check (
    char_length(target_type) between 1 and 100
    and target_type ~ '^[a-z][a-z0-9_]*$'
  );

-- create_and_attach is already a runtime-supported legacy intent used by the
-- pricing proposal path; keep the persisted compatibility contract aligned.
alter table public.change_requests
  drop constraint if exists change_requests_intent_check;

alter table public.change_requests
  add constraint change_requests_intent_check
  check (
    intent in (
      'create',
      'create_and_attach',
      'update',
      'publish',
      'cancel',
      'archive'
    )
  );

create index if not exists change_requests_account_action_status_idx
  on public.change_requests(
    account_id,
    action_key,
    action_version,
    status,
    created_at desc
  )
  where action_key is not null;

-- One canonical digest function prevents create/approve/claim drift.
-- For legacy rows (action_key IS NULL), the byte input is intentionally
-- identical to migrations 065/074/075 so existing content_digest values remain
-- valid without a backfill.
create or replace function public.change_request_content_digest(
  p_action_key text,
  p_action_version integer,
  p_target_type text,
  p_target_id uuid,
  p_intent text,
  p_proposed_payload jsonb,
  p_expected_version bigint
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    digest(
      case
        when p_action_key is null then
          p_target_type || '|' || coalesce(p_target_id::text, '') || '|' ||
          p_intent || '|' ||
          coalesce(p_proposed_payload, '{}'::jsonb)::text || '|' ||
          coalesce(p_expected_version::text, '')
        else
          'action:' || p_action_key || '@' || p_action_version::text || '|' ||
          p_target_type || '|' || coalesce(p_target_id::text, '') || '|' ||
          p_intent || '|' ||
          coalesce(p_proposed_payload, '{}'::jsonb)::text || '|' ||
          coalesce(p_expected_version::text, '')
      end,
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.change_request_content_digest(
  text, integer, text, uuid, text, jsonb, bigint
) from public, anon, authenticated;

grant execute on function public.change_request_content_digest(
  text, integer, text, uuid, text, jsonb, bigint
) to service_role;

-- Additive v3 create boundary. v2 remains installed for historical/external
-- compatibility; application code migrates to v3 and may pass NULL action
-- identity for still-legacy actions.
create or replace function public.create_change_request_v3(
  p_account_id uuid,
  p_action_key text,
  p_action_version integer,
  p_target_type text,
  p_target_id uuid,
  p_intent text,
  p_proposed_payload jsonb,
  p_expected_version bigint,
  p_idempotency_key text,
  p_summary text,
  p_actor_user_id uuid
)
returns table(
  id uuid,
  code integer,
  confirmation_code text,
  status text,
  content_digest text
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
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
  if (p_action_key is null) <> (p_action_version is null) then
    raise exception 'CHANGE_REQUEST_ACTION_IDENTITY_INCOMPLETE'
      using errcode = 'P0001';
  end if;

  if p_action_key is not null and (
    char_length(p_action_key) < 3
    or char_length(p_action_key) > 160
    or p_action_key !~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'
    or p_action_version < 1
  ) then
    raise exception 'CHANGE_REQUEST_INVALID_ACTION_IDENTITY'
      using errcode = 'P0001';
  end if;

  if p_target_type is null
     or char_length(p_target_type) < 1
     or char_length(p_target_type) > 100
     or p_target_type !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'CHANGE_REQUEST_INVALID_TARGET_TYPE'
      using errcode = 'P0001';
  end if;

  if p_intent not in (
    'create',
    'create_and_attach',
    'update',
    'publish',
    'cancel',
    'archive'
  ) then
    raise exception 'CHANGE_REQUEST_INVALID_INTENT'
      using errcode = 'P0001';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 16 then
    raise exception 'CHANGE_REQUEST_INVALID_IDEMPOTENCY_KEY'
      using errcode = 'P0001';
  end if;

  select cr.*
    into v_existing
    from public.change_requests as cr
   where cr.account_id = p_account_id
     and cr.idempotency_key = p_idempotency_key;

  if found then
    id := v_existing.id;
    code := v_existing.code;
    confirmation_code := null;
    status := v_existing.status;
    content_digest := v_existing.content_digest;
    return next;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_account_id::text), 65065);

  select coalesce(max(cr.code), 0) + 1
    into v_code
    from public.change_requests as cr
   where cr.account_id = p_account_id;

  v_b0 := get_byte(gen_random_bytes(2), 0);
  v_b1 := get_byte(gen_random_bytes(2), 1);
  v_pin := lpad(
    (1000 + ((v_b0 * 256 + v_b1) % 9000))::text,
    4,
    '0'
  );

  v_digest := public.change_request_content_digest(
    p_action_key,
    p_action_version,
    p_target_type,
    p_target_id,
    p_intent,
    coalesce(p_proposed_payload, '{}'::jsonb),
    p_expected_version
  );

  insert into public.change_requests(
    account_id,
    code,
    action_key,
    action_version,
    target_type,
    target_id,
    intent,
    proposed_payload,
    expected_version,
    idempotency_key,
    status,
    confirmation_code,
    confirmation_code_hash,
    content_digest,
    summary,
    created_by
  ) values (
    p_account_id,
    v_code,
    p_action_key,
    p_action_version,
    p_target_type,
    p_target_id,
    p_intent,
    coalesce(p_proposed_payload, '{}'::jsonb),
    p_expected_version,
    p_idempotency_key,
    'pending',
    '****',
    crypt(v_pin, gen_salt('bf', 8)),
    v_digest,
    p_summary,
    p_actor_user_id
  )
  returning change_requests.id into v_id;

  id := v_id;
  code := v_code;
  confirmation_code := v_pin;
  status := 'pending';
  content_digest := v_digest;

  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_id,
    'change_request.created',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_strip_nulls(
      jsonb_build_object(
        'code', v_code,
        'action_key', p_action_key,
        'action_version', p_action_version,
        'target_type', p_target_type,
        'intent', p_intent,
        'digest', v_digest
      )
    )
  );

  return next;
end;
$$;

revoke all on function public.create_change_request_v3(
  uuid, text, integer, text, uuid, text, jsonb, bigint, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.create_change_request_v3(
  uuid, text, integer, text, uuid, text, jsonb, bigint, text, text, uuid
) to service_role;

-- Approval checks use one digest function. Legacy rows still hash exactly as
-- before because action_key/action_version are NULL.
create or replace function public.approve_change_request_by_code_v2(
  p_account_id uuid,
  p_request_code integer,
  p_confirmation_code text,
  p_identity_id uuid,
  p_message_id uuid default null,
  p_run_id uuid default null
)
returns table(id uuid, status text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.change_requests%rowtype;
  v_identity public.trusted_admin_identities%rowtype;
  v_digest text;
begin
  select tai.*
    into v_identity
    from public.trusted_admin_identities as tai
   where tai.id = p_identity_id
     and tai.account_id = p_account_id
     and tai.channel = 'whatsapp'
     and tai.status = 'active'
   for share;

  if not found then
    raise exception 'TRUSTED_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if not (v_identity.allowed_capabilities ? 'change_requests.approve') then
    raise exception 'APPROVER_CAPABILITY_REQUIRED' using errcode = '42501';
  end if;

  select cr.*
    into v_row
    from public.change_requests as cr
   where cr.account_id = p_account_id
     and cr.code = p_request_code
   for update;

  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_row.status <> 'pending' then
    id := v_row.id;
    status := v_row.status;
    return next;
    return;
  end if;

  if v_row.expires_at < now() then
    update public.change_requests as cr
       set status = 'expired'
     where cr.id = v_row.id;
    id := v_row.id;
    status := 'expired';
    return next;
    return;
  end if;

  if v_row.approval_attempts >= 5 then
    id := v_row.id;
    status := 'locked';
    return next;
    return;
  end if;

  v_digest := public.change_request_content_digest(
    v_row.action_key,
    v_row.action_version,
    v_row.target_type,
    v_row.target_id,
    v_row.intent,
    v_row.proposed_payload,
    v_row.expected_version
  );

  if v_digest <> v_row.content_digest then
    raise exception 'CHANGE_REQUEST_CONTENT_CHANGED' using errcode = 'P0001';
  end if;

  if v_row.confirmation_code_hash is null
     or crypt(
       coalesce(p_confirmation_code, ''),
       v_row.confirmation_code_hash
     ) <> v_row.confirmation_code_hash then
    update public.change_requests as cr
       set approval_attempts = v_row.approval_attempts + 1
     where cr.id = v_row.id;
    id := v_row.id;
    status := 'bad_code';
    return next;
    return;
  end if;

  update public.change_requests as cr
     set status = 'approved',
         approved_at = now(),
         approved_identity_id = p_identity_id,
         approved_message_id = p_message_id,
         approved_run_id = p_run_id,
         approved_by = v_identity.member_id,
         approval_attempts = 0
   where cr.id = v_row.id
     and cr.status = 'pending';

  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.approved',
    'service',
    p_identity_id::text,
    jsonb_build_object(
      'code', v_row.code,
      'digest', v_row.content_digest
    )
  );

  id := v_row.id;
  status := 'approved';
  return next;
end;
$$;

revoke execute on function public.approve_change_request_by_code_v2(
  uuid, integer, text, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.approve_change_request_by_code_v2(
  uuid, integer, text, uuid, uuid, uuid
) to service_role;

create or replace function public.approve_change_request_dashboard_v2(
  p_account_id uuid,
  p_change_request_id uuid,
  p_confirmation_code text,
  p_actor_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.change_requests%rowtype;
  v_digest text;
begin
  if p_actor_user_id is null
     or not is_account_member(p_account_id, 'admin') then
    raise exception 'CHANGE_REQUEST_APPROVER_FORBIDDEN'
      using errcode='42501';
  end if;

  select cr.*
    into v_row
    from public.change_requests as cr
   where cr.id = p_change_request_id
     and cr.account_id = p_account_id
   for update;

  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode='P0002';
  end if;

  if v_row.status = 'approved' then
    return 'approved';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'CHANGE_REQUEST_NOT_PENDING' using errcode='P0001';
  end if;

  if v_row.expires_at < now() then
    update public.change_requests as cr
       set status='expired'
     where cr.id=v_row.id;
    raise exception 'CHANGE_REQUEST_EXPIRED' using errcode='P0001';
  end if;

  if v_row.approval_attempts >= 5 then
    raise exception 'CHANGE_REQUEST_TOO_MANY_ATTEMPTS'
      using errcode='P0001';
  end if;

  v_digest := public.change_request_content_digest(
    v_row.action_key,
    v_row.action_version,
    v_row.target_type,
    v_row.target_id,
    v_row.intent,
    v_row.proposed_payload,
    v_row.expected_version
  );

  if v_digest <> v_row.content_digest then
    raise exception 'CHANGE_REQUEST_CONTENT_CHANGED'
      using errcode='P0001';
  end if;

  if v_row.confirmation_code_hash is null
     or crypt(
       coalesce(p_confirmation_code,''),
       v_row.confirmation_code_hash
     ) <> v_row.confirmation_code_hash then
    update public.change_requests as cr
       set approval_attempts=approval_attempts+1
     where cr.id=v_row.id;
    raise exception 'CHANGE_REQUEST_BAD_CODE' using errcode='P0001';
  end if;

  update public.change_requests as cr
     set status='approved',
         approved_at=now(),
         approved_by=p_actor_user_id,
         approval_attempts=0
   where cr.id=v_row.id
     and cr.status='pending';

  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.approved',
    'user',
    p_actor_user_id::text,
    jsonb_build_object(
      'code', v_row.code,
      'digest', v_row.content_digest
    )
  );

  return 'approved';
end;
$$;

revoke execute on function public.approve_change_request_dashboard_v2(
  uuid, uuid, text, uuid
) from public, anon, authenticated;

grant execute on function public.approve_change_request_dashboard_v2(
  uuid, uuid, text, uuid
) to service_role;

-- Additive claim boundary carrying exact action identity. The old claim
-- function remains installed for compatibility with older application code.
create or replace function public.claim_change_request_execution_v2(
  p_account_id uuid,
  p_change_request_id uuid
)
returns table(
  id uuid,
  action_key text,
  action_version integer,
  target_type text,
  target_id uuid,
  intent text,
  proposed_payload jsonb,
  expected_version bigint,
  content_digest text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.change_requests%rowtype;
  v_token uuid := gen_random_uuid();
  v_digest text;
begin
  select cr.*
    into v_row
    from public.change_requests as cr
   where cr.id = p_change_request_id
     and cr.account_id = p_account_id
   for update;

  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_row.status = 'executed' then
    return;
  end if;

  if v_row.status <> 'approved' then
    raise exception 'CHANGE_REQUEST_NOT_APPROVED' using errcode = 'P0001';
  end if;

  if v_row.expires_at < now() then
    raise exception 'CHANGE_REQUEST_EXPIRED' using errcode = 'P0001';
  end if;

  v_digest := public.change_request_content_digest(
    v_row.action_key,
    v_row.action_version,
    v_row.target_type,
    v_row.target_id,
    v_row.intent,
    v_row.proposed_payload,
    v_row.expected_version
  );

  if v_digest <> v_row.content_digest then
    raise exception 'CHANGE_REQUEST_CONTENT_CHANGED' using errcode = 'P0001';
  end if;

  update public.change_requests as cr
     set status = 'executing',
         executing_started_at = now(),
         execution_claim_token = v_token
   where cr.id = v_row.id
     and cr.status = 'approved';

  if not found then
    raise exception 'CHANGE_REQUEST_EXECUTION_RACE'
      using errcode = '40001';
  end if;

  id := v_row.id;
  action_key := v_row.action_key;
  action_version := v_row.action_version;
  target_type := v_row.target_type;
  target_id := v_row.target_id;
  intent := v_row.intent;
  proposed_payload := v_row.proposed_payload;
  expected_version := v_row.expected_version;
  content_digest := v_row.content_digest;
  claim_token := v_token;
  return next;
end;
$$;

revoke all on function public.claim_change_request_execution_v2(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.claim_change_request_execution_v2(uuid, uuid)
  to service_role;
