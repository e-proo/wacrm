-- ============================================================
-- 075_fix_change_request_execution_rpcs.sql
-- Eliminate PL/pgSQL output-column ambiguity in the deterministic
-- change-request execution lifecycle and keep service-owned RPCs locked down.
-- ============================================================

create or replace function public.claim_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid
)
returns table(
  id uuid,
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

  v_digest := encode(
    digest(
      v_row.target_type || '|' || coalesce(v_row.target_id::text, '') || '|' ||
      v_row.intent || '|' || coalesce(v_row.proposed_payload, '{}'::jsonb)::text || '|' ||
      coalesce(v_row.expected_version::text, ''),
      'sha256'
    ),
    'hex'
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
    raise exception 'CHANGE_REQUEST_EXECUTION_RACE' using errcode = '40001';
  end if;

  id := v_row.id;
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

create or replace function public.complete_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid,
  p_claim_token uuid,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  update public.change_requests as cr
     set status = 'executed',
         executed_at = now(),
         execution_result = coalesce(p_result, '{}'::jsonb),
         error_code = null,
         execution_claim_token = null
   where cr.id = p_change_request_id
     and cr.account_id = p_account_id
     and cr.status = 'executing'
     and cr.execution_claim_token = p_claim_token;

  return found;
end;
$$;

create or replace function public.fail_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  update public.change_requests as cr
     set status = 'failed',
         error_code = left(coalesce(p_error_code, 'EXECUTION_FAILED'), 120),
         execution_claim_token = null
   where cr.id = p_change_request_id
     and cr.account_id = p_account_id
     and cr.status = 'executing'
     and cr.execution_claim_token = p_claim_token;

  return found;
end;
$$;

revoke execute on function public.claim_change_request_execution(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_change_request_execution(uuid, uuid)
  to service_role;

revoke execute on function public.complete_change_request_execution(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_change_request_execution(uuid, uuid, uuid, jsonb)
  to service_role;

revoke execute on function public.fail_change_request_execution(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_change_request_execution(uuid, uuid, uuid, text)
  to service_role;
