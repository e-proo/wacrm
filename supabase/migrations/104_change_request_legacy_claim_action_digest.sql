-- ============================================================
-- 104_change_request_legacy_claim_action_digest.sql
-- Rolling-deploy compatibility for the pre-action claim RPC.
--
-- The old return contract is preserved exactly, but digest verification uses
-- the canonical helper from migration 103 so an older application instance can
-- safely claim a row created with action_key/action_version by a newer instance.
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

revoke execute on function public.claim_change_request_execution(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.claim_change_request_execution(uuid, uuid)
  to service_role;
