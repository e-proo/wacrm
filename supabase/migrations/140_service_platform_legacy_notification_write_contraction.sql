-- ============================================================
-- 140_service_platform_legacy_notification_write_contraction.sql
-- Phase 5: contract the historical customer_intent_notifications write path.
--
-- This is intentionally account/route scoped and reversible:
--   * existing accounts keep legacy writes enabled by default;
--   * retirement can be enabled only for an active, ready route;
--   * legacy mode always permits fallback writes again;
--   * rollback cannot demote an unsent active Business Event that has no
--     historical fallback row.
--
-- The historical table/RPCs/triggers remain in place for legacy-mode accounts,
-- old rows, and controlled rollback. Later Phase 5 work may remove more
-- compatibility surface only after the retired path is proven on TEST.
-- ============================================================

alter table public.business_event_delivery_controls
  add column if not exists legacy_notification_write_enabled boolean
    not null default true;

comment on column public.business_event_delivery_controls.legacy_notification_write_enabled is
  'Phase 5 strangler control. When false on an active route, covered native Business Events stop dual-writing new customer_intent_notifications rows. Legacy mode always resumes fallback writes.';

create or replace function public.set_business_event_legacy_notification_write_enabled(
  p_account_id uuid,
  p_route_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_mode text;
  v_current boolean;
  v_readiness jsonb;
begin
  if p_route_key not in (
    'fx_trade_customer_whatsapp',
    'coverage_customer_whatsapp',
    'service_request_customer_whatsapp'
  ) then
    raise exception 'BUSINESS_EVENT_LEGACY_WRITE_ROUTE_UNSUPPORTED:%', p_route_key;
  end if;

  select c.mode, c.legacy_notification_write_enabled
    into v_mode, v_current
    from public.business_event_delivery_controls as c
   where c.account_id = p_account_id
     and c.route_key = p_route_key;

  if v_mode is null then
    raise exception 'BUSINESS_EVENT_LEGACY_WRITE_CONTROL_NOT_FOUND:%', p_route_key;
  end if;

  if v_current = p_enabled then
    return jsonb_build_object(
      'route_key', p_route_key,
      'mode', v_mode,
      'legacy_notification_write_enabled', v_current,
      'changed', false
    );
  end if;

  if p_enabled is false then
    if v_mode <> 'active' then
      raise exception 'BUSINESS_EVENT_LEGACY_WRITE_RETIREMENT_REQUIRES_ACTIVE:%',
        p_route_key;
    end if;

    v_readiness := case p_route_key
      when 'fx_trade_customer_whatsapp'
        then public.inspect_fx_business_event_cutover_readiness(p_account_id)
      when 'coverage_customer_whatsapp'
        then public.inspect_coverage_business_event_cutover_readiness(p_account_id)
      when 'service_request_customer_whatsapp'
        then public.inspect_intents_business_event_cutover_readiness(p_account_id)
    end;

    if coalesce((v_readiness ->> 'ready')::boolean, false) is not true then
      raise exception 'BUSINESS_EVENT_LEGACY_WRITE_RETIREMENT_NOT_READY:%:%',
        p_route_key,
        v_readiness::text;
    end if;
  end if;

  update public.business_event_delivery_controls
     set legacy_notification_write_enabled = p_enabled,
         updated_at = pg_catalog.now()
   where account_id = p_account_id
     and route_key = p_route_key;

  return jsonb_build_object(
    'route_key', p_route_key,
    'mode', v_mode,
    'legacy_notification_write_enabled', p_enabled,
    'changed', true
  );
end;
$$;

revoke execute on function public.set_business_event_legacy_notification_write_enabled(
  uuid, text, boolean
) from public, anon, authenticated;

grant execute on function public.set_business_event_legacy_notification_write_enabled(
  uuid, text, boolean
) to service_role;

create or replace function public.suppress_retired_legacy_customer_notification()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_route_key text;
  v_target_type text;
  v_action_key text;
  v_action_version integer;
begin
  if new.fx_trade_request_id is not null
     and new.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[]) then
    v_route_key := 'fx_trade_customer_whatsapp';
  elsif new.change_request_id is not null then
    select cr.target_type, cr.action_key, cr.action_version
      into v_target_type, v_action_key, v_action_version
      from public.change_requests as cr
     where cr.account_id = new.account_id
       and cr.id = new.change_request_id;

    if v_target_type in ('coverage_offer', 'coverage_request')
       and new.event_type = 'approved_and_applied' then
      v_route_key := 'coverage_customer_whatsapp';
    elsif v_target_type = 'service_intent'
       and new.event_type = any(array[
         'approved_and_applied',
         'rejected',
         'matched',
         'needs_clarification'
       ]::text[])
       and (
         (v_action_key = 'intents.decision.apply' and v_action_version = 1)
         or v_action_key is null
       ) then
      v_route_key := 'service_request_customer_whatsapp';
    end if;
  end if;

  if v_route_key is null then
    return new;
  end if;

  if exists (
    select 1
    from public.business_event_delivery_controls as c
    where c.account_id = new.account_id
      and c.route_key = v_route_key
      and c.mode = 'active'
      and c.legacy_notification_write_enabled is false
  ) then
    return null;
  end if;

  return new;
end;
$$;

revoke all on function public.suppress_retired_legacy_customer_notification()
  from public, anon, authenticated;

drop trigger if exists customer_intent_notifications_legacy_write_guard
  on public.customer_intent_notifications;

create trigger customer_intent_notifications_legacy_write_guard
  before insert on public.customer_intent_notifications
  for each row
  execute function public.suppress_retired_legacy_customer_notification();

create or replace function public.guard_unlinked_active_business_event_demotion()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if old.delivery_mode = 'active'
     and new.delivery_mode = 'shadow'
     and old.status in ('pending', 'failed')
     and old.legacy_notification_id is null
     and old.audience = 'customer'
     and old.channel = 'whatsapp'
     and old.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed',
       'coverage.offer.approved',
       'coverage.request.approved',
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
     ]::text[]) then
    raise exception 'BUSINESS_EVENT_ROLLBACK_FALLBACK_MISSING:%', old.event_type;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_unlinked_active_business_event_demotion()
  from public, anon, authenticated;

drop trigger if exists business_event_outbox_unlinked_demotion_guard
  on public.business_event_outbox;

create trigger business_event_outbox_unlinked_demotion_guard
  before update of delivery_mode on public.business_event_outbox
  for each row
  execute function public.guard_unlinked_active_business_event_demotion();
