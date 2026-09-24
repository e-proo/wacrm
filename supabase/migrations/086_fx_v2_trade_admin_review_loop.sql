-- ============================================================
-- 086_fx_v2_trade_admin_review_loop.sql
-- Close the FX V2 customer -> trusted-admin -> customer loop.
--
-- Customer trade requests are created in pending_admin and are reviewed through
-- the existing change-request approval surface. Approval is already executed by
-- the deterministic fx_trade_request change-request executor. This migration
-- makes the generic rejection path equally authoritative: rejecting the review
-- and rejecting the FX trade happen in the same database transaction.
-- ============================================================

create or replace function public.reject_change_request(
  p_account_id        uuid,
  p_change_request_id uuid,
  p_actor_user_id     uuid,
  p_reason            text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.change_requests%rowtype;
  v_is_fx_trade_review boolean := false;
begin
  select * into v_row
    from public.change_requests
   where id = p_change_request_id
     and account_id = p_account_id
   for update;

  if not found then
    raise exception 'CHANGE_REQUEST_NOT_FOUND'
      using errcode = 'P0001';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'CHANGE_REQUEST_NOT_PENDING'
      using errcode = 'P0001';
  end if;

  v_is_fx_trade_review :=
    v_row.target_type = 'fx_trade_request'
    and v_row.intent = 'update'
    and v_row.target_id is not null;

  if v_row.target_type = 'fx_trade_request' and not v_is_fx_trade_review then
    raise exception 'FX_TRADE_REVIEW_PAYLOAD_INVALID'
      using errcode = 'P0001';
  end if;

  if v_is_fx_trade_review then
    if coalesce(v_row.proposed_payload->>'expected_status', '') <> 'pending_admin'
       or coalesce(v_row.proposed_payload->>'decision', '') <> 'approve' then
      raise exception 'FX_TRADE_REVIEW_PAYLOAD_INVALID'
        using errcode = 'P0001';
    end if;
  end if;

  update public.change_requests
     set status = 'rejected',
         rejected_at = pg_catalog.now(),
         rejected_by = p_actor_user_id,
         summary = coalesce(p_reason, summary)
   where id = v_row.id
     and account_id = p_account_id
     and status = 'pending';

  if not found then
    raise exception 'CHANGE_REQUEST_NOT_PENDING'
      using errcode = 'P0001';
  end if;

  perform public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_row.id,
    'change_request.rejected',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('code', v_row.code, 'reason', p_reason)
  );

  -- Keep the business entity and its human review in one transaction. The
  -- FX lifecycle trigger added in migration 084 then enqueues the durable
  -- exchange_rate.trade.rejected customer notification with this CHG id.
  if v_is_fx_trade_review then
    perform public.decide_exchange_trade_request_v2(
      p_account_id,
      v_row.target_id,
      'pending_admin',
      'reject',
      v_row.id,
      p_reason,
      p_actor_user_id
    );
  end if;

  return 'rejected';
end;
$$;

revoke all on function public.reject_change_request(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reject_change_request(uuid, uuid, uuid, text)
  to service_role;
