-- ============================================================
-- 099_fx_cutover_readiness_diagnostics.sql
-- Add operator-facing diagnostics to the existing FX cutover readiness gate.
--
-- This migration does NOT change readiness semantics:
--   * all four canonical FX customer event types must have matched legacy
--     shadow evidence
--   * no blocking shadow rows
--   * no nonterminal legacy FX rows
--   * no nonterminal active FX rows
-- ============================================================

create or replace function public.inspect_fx_business_event_cutover_readiness(
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_mode text;
  v_matched_event_types integer;
  v_evidence_rows integer;
  v_blockers integer;
  v_legacy_nonterminal integer;
  v_active_nonterminal integer;
  v_matched_keys text[] := array[]::text[];
  v_missing_keys text[] := array[]::text[];
  v_pending_keys text[] := array[]::text[];
  v_ready boolean;
begin
  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = p_account_id
        and c.route_key = 'fx_trade_customer_whatsapp'
    ),
    'legacy'
  ) into v_mode;

  select
    count(*)::integer,
    count(distinct beo.event_type)::integer,
    coalesce(
      array_agg(distinct beo.event_type order by beo.event_type),
      array[]::text[]
    )
  into v_evidence_rows, v_matched_event_types, v_matched_keys
  from public.business_event_outbox as beo
  where beo.account_id = p_account_id
    and beo.delivery_mode = 'shadow'
    and beo.subject_type = 'fx_trade_request'
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed'
    ]::text[])
    and beo.shadow_projection_status = 'matched_legacy'
    and beo.legacy_notification_id is not null;

  select coalesce(
    array_agg(required.event_type order by required.event_type),
    array[]::text[]
  )
  into v_missing_keys
  from unnest(array[
    'exchange_rate.trade.requested',
    'exchange_rate.trade.approved',
    'exchange_rate.trade.rejected',
    'exchange_rate.trade.completed'
  ]::text[]) as required(event_type)
  where not (required.event_type = any(v_matched_keys));

  select coalesce(
    array_agg(distinct beo.event_type order by beo.event_type),
    array[]::text[]
  )
  into v_pending_keys
  from public.business_event_outbox as beo
  where beo.account_id = p_account_id
    and beo.delivery_mode = 'shadow'
    and beo.subject_type = 'fx_trade_request'
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed'
    ]::text[])
    and beo.shadow_projection_status in ('pending', 'checking');

  select count(*)::integer
    into v_blockers
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'shadow'
     and beo.subject_type = 'fx_trade_request'
     and beo.audience = 'customer'
     and beo.channel = 'whatsapp'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and (
       beo.shadow_projection_status <> 'matched_legacy'
       or beo.legacy_notification_id is null
     );

  select count(*)::integer
    into v_legacy_nonterminal
    from public.customer_intent_notifications as cin
   where cin.account_id = p_account_id
     and cin.fx_trade_request_id is not null
     and cin.status in ('pending', 'sending', 'requires_reconciliation');

  select count(*)::integer
    into v_active_nonterminal
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'fx_trade_request'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and beo.status in (
       'pending',
       'sending',
       'failed',
       'requires_reconciliation'
     );

  v_ready :=
    v_matched_event_types = 4
    and v_blockers = 0
    and v_legacy_nonterminal = 0
    and v_active_nonterminal = 0;

  return jsonb_build_object(
    'route_key', 'fx_trade_customer_whatsapp',
    'mode', v_mode,
    'ready', v_ready,
    'required_event_types', 4,
    'matched_event_types', v_matched_event_types,
    'matched_event_type_keys', to_jsonb(v_matched_keys),
    'missing_event_types', to_jsonb(v_missing_keys),
    'pending_event_types', to_jsonb(v_pending_keys),
    'evidence_rows', v_evidence_rows,
    'blockers', v_blockers,
    'legacy_nonterminal', v_legacy_nonterminal,
    'active_nonterminal', v_active_nonterminal
  );
end;
$$;

revoke execute on function public.inspect_fx_business_event_cutover_readiness(uuid)
  from public, anon, authenticated;

grant execute on function public.inspect_fx_business_event_cutover_readiness(uuid)
  to service_role;
