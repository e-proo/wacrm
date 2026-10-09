-- ============================================================
-- 074_fix_trusted_admin_change_approval_rpc.sql
-- Fix PL/pgSQL output-column ambiguity in trusted-admin approval.
--
-- approve_change_request_by_code_v2 RETURNS TABLE(id, status). Unqualified
-- references to table columns named id/status therefore collide with those
-- output variables under PL/pgSQL name resolution. Qualify every table column
-- and preserve the service_role-only execution boundary from migration 073.
-- ============================================================

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

  if v_row.confirmation_code_hash is null
     or crypt(coalesce(p_confirmation_code, ''), v_row.confirmation_code_hash) <> v_row.confirmation_code_hash then
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
    jsonb_build_object('code', v_row.code, 'digest', v_row.content_digest)
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
