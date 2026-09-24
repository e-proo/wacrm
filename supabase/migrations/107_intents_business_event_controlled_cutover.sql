-- ============================================================
-- 107_intents_business_event_controlled_cutover.sql
-- Controlled Intents / service-request customer-message cutover.
--
-- Migration 102 remains the native atomic producer. This migration:
--   * keeps legacy delivery as the default;
--   * routes FUTURE change-request-backed Intents outcomes only;
--   * requires durable shadow parity before activation;
--   * reuses the generic legacy-claim suppression introduced in 106;
--   * provides a guarded reversible rollback.
--
-- service_request.completed is intentionally excluded: the current
-- customer_intents lifecycle has no authoritative "completed" transition.
-- ============================================================

create or replace function public.route_service_intent_customer_business_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_route_active boolean := false;
begin
  if tg_op <> 'UPDATE'
     or new.status is not distinct from old.status
     or new.change_request_id is null then
    return new;
  end if;

  v_event_type := case new.status
    when 'fulfilled' then 'service_request.approved'
    when 'rejected' then 'service_request.rejected'
    when 'matched' then 'service_request.matched'
    when 'clarifying' then 'service_request.needs_clarification'
    else null
  end;

  if v_event_type is null then
    return new;
  end if;

  select exists (
    select 1
    from public.business_event_delivery_controls as c
    where c.account_id = new.account_id
      and c.route_key = 'service_request_customer_whatsapp'
      and c.mode = 'active'
  ) into v_route_active;

  if not v_route_active then
    return new;
  end if;

  update public.business_event_outbox as beo
     set delivery_mode = 'active'
   where beo.account_id = new.account_id
     and beo.event_type = v_event_type
     and beo.event_version = 1
     and beo.subject_type = 'service_intent'
     and beo.subject_id = new.id::text
     and beo.correlation_id = new.change_request_id::text
     and beo.delivery_mode = 'shadow'
     and beo.status = 'pending'
     and beo.created_at >= pg_catalog.transaction_timestamp();

  return new;
end;
$$;

revoke all on function public.route_service_intent_customer_business_event()
  from public, anon, authenticated;

drop trigger if exists customer_intents_business_event_zz_route
  on public.customer_intents;

create trigger customer_intents_business_event_zz_route
  after update of status on public.customer_intents
  for each row
  execute function public.route_service_intent_customer_business_event();

create or replace function public.inspect_intents_business_event_cutover_readiness(
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
        and c.route_key = 'service_request_customer_whatsapp'
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
    and beo.subject_type = 'service_intent'
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'service_request.approved',
      'service_request.rejected',
      'service_request.matched',
      'service_request.needs_clarification'
    ]::text[])
    and beo.shadow_projection_status = 'matched_legacy'
    and beo.legacy_notification_id is not null;

  select coalesce(
    array_agg(required.event_type order by required.event_type),
    array[]::text[]
  )
  into v_missing_keys
  from unnest(array[
    'service_request.approved',
    'service_request.rejected',
    'service_request.matched',
    'service_request.needs_clarification'
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
    and beo.subject_type = 'service_intent'
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'service_request.approved',
      'service_request.rejected',
      'service_request.matched',
      'service_request.needs_clarification'
    ]::text[])
    and beo.shadow_projection_status in ('pending', 'checking');

  select count(*)::integer
    into v_blockers
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'shadow'
     and beo.subject_type = 'service_intent'
     and beo.audience = 'customer'
     and beo.channel = 'whatsapp'
     and beo.event_type = any(array[
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
     ]::text[])
     and (
       beo.shadow_projection_status <> 'matched_legacy'
       or beo.legacy_notification_id is null
     );

  select count(*)::integer
    into v_legacy_nonterminal
    from public.customer_intent_notifications as cin
    join public.change_requests as cr
      on cr.account_id = cin.account_id
     and cr.id = cin.change_request_id
   where cin.account_id = p_account_id
     and cr.target_type = 'service_intent'
     and cin.event_type in (
       'approved_and_applied',
       'rejected',
       'matched',
       'needs_clarification'
     )
     and cin.status in ('pending', 'sending', 'requires_reconciliation');

  select count(*)::integer
    into v_active_nonterminal
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'service_intent'
     and beo.event_type = any(array[
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
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
    'route_key', 'service_request_customer_whatsapp',
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

revoke execute on function public.inspect_intents_business_event_cutover_readiness(uuid)
  from public, anon, authenticated;

grant execute on function public.inspect_intents_business_event_cutover_readiness(uuid)
  to service_role;

create or replace function public.set_intents_business_event_delivery_mode(
  p_account_id uuid,
  p_mode text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_current_mode text;
  v_readiness jsonb;
  v_inflight integer;
  v_demoted integer := 0;
  v_synced integer := 0;
begin
  if p_mode not in ('legacy', 'active') then
    raise exception 'INTENTS_BUSINESS_EVENT_MODE_INVALID';
  end if;

  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = p_account_id
        and c.route_key = 'service_request_customer_whatsapp'
    ),
    'legacy'
  ) into v_current_mode;

  if v_current_mode = p_mode then
    return jsonb_build_object(
      'route_key', 'service_request_customer_whatsapp',
      'mode', v_current_mode,
      'changed', false
    );
  end if;

  if p_mode = 'active' then
    v_readiness :=
      public.inspect_intents_business_event_cutover_readiness(p_account_id);

    if coalesce((v_readiness ->> 'ready')::boolean, false) is not true then
      raise exception 'INTENTS_BUSINESS_EVENT_CUTOVER_NOT_READY:%',
        v_readiness::text;
    end if;

    insert into public.business_event_delivery_controls (
      account_id,
      route_key,
      mode,
      created_at,
      updated_at
    ) values (
      p_account_id,
      'service_request_customer_whatsapp',
      'active',
      pg_catalog.now(),
      pg_catalog.now()
    )
    on conflict (account_id, route_key) do update
      set mode = excluded.mode,
          updated_at = pg_catalog.now();

    return jsonb_build_object(
      'route_key', 'service_request_customer_whatsapp',
      'mode', 'active',
      'changed', true
    );
  end if;

  select count(*)::integer
    into v_inflight
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'service_intent'
     and beo.event_type = any(array[
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
     ]::text[])
     and beo.status in ('sending', 'requires_reconciliation');

  if v_inflight > 0 then
    raise exception 'INTENTS_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT';
  end if;

  update public.customer_intent_notifications as cin
     set status = 'sent',
         local_message_id = coalesce(cin.local_message_id, beo.local_message_id),
         sent_at = coalesce(cin.sent_at, beo.sent_at, pg_catalog.now()),
         last_error = null,
         claim_token = null
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'service_intent'
     and beo.event_type = any(array[
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
     ]::text[])
     and beo.status = 'sent'
     and beo.legacy_notification_id = cin.id
     and cin.account_id = p_account_id
     and cin.status <> 'sent';

  get diagnostics v_synced = row_count;

  update public.business_event_outbox as beo
     set delivery_mode = 'shadow',
         claim_token = null,
         claimed_at = null
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'service_intent'
     and beo.event_type = any(array[
       'service_request.approved',
       'service_request.rejected',
       'service_request.matched',
       'service_request.needs_clarification'
     ]::text[])
     and beo.status in ('pending', 'failed');

  get diagnostics v_demoted = row_count;

  insert into public.business_event_delivery_controls (
    account_id,
    route_key,
    mode,
    created_at,
    updated_at
  ) values (
    p_account_id,
    'service_request_customer_whatsapp',
    'legacy',
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (account_id, route_key) do update
    set mode = excluded.mode,
        updated_at = pg_catalog.now();

  return jsonb_build_object(
    'route_key', 'service_request_customer_whatsapp',
    'mode', 'legacy',
    'changed', true,
    'demoted_unsent', v_demoted,
    'synced_legacy_sent', v_synced
  );
end;
$$;

revoke execute on function public.set_intents_business_event_delivery_mode(uuid, text)
  from public, anon, authenticated;

grant execute on function public.set_intents_business_event_delivery_mode(uuid, text)
  to service_role;
