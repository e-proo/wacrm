-- ============================================================
-- 106_coverage_business_event_controlled_cutover.sql
-- Controlled Coverage customer-message cutover.
--
-- Coverage native producers from migration 093 remain the source of canonical
-- snapshots. This migration only routes FUTURE approved customer events,
-- generalizes legacy-claim suppression by canonical linkage, and adds a
-- reversible readiness-gated delivery switch.
-- ============================================================

-- -----------------------------------------------------------------
-- Future Coverage approved events follow the account route.
-- The existing ..._business_event_shadow producer trigger fires first;
-- PostgreSQL orders triggers of the same kind alphabetically, so the zz_route
-- trigger below can safely promote the row created by that producer.
-- -----------------------------------------------------------------
create or replace function public.route_coverage_customer_business_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_subject_type text;
  v_route_active boolean := false;
begin
  if tg_op <> 'INSERT'
     or new.status <> 'active'
     or new.source_change_request_id is null then
    return new;
  end if;

  if tg_table_name = 'coverage_offers' then
    v_event_type := 'coverage.offer.approved';
    v_subject_type := 'coverage_offer';
  elsif tg_table_name = 'coverage_requests' then
    v_event_type := 'coverage.request.approved';
    v_subject_type := 'coverage_request';
  else
    return new;
  end if;

  select exists (
    select 1
    from public.business_event_delivery_controls as c
    where c.account_id = new.account_id
      and c.route_key = 'coverage_customer_whatsapp'
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
     and beo.subject_type = v_subject_type
     and beo.subject_id = new.id::text
     and beo.delivery_mode = 'shadow'
     and beo.status = 'pending';

  return new;
end;
$$;

revoke all on function public.route_coverage_customer_business_event()
  from public, anon, authenticated;

drop trigger if exists coverage_offers_business_event_zz_route
  on public.coverage_offers;

create trigger coverage_offers_business_event_zz_route
  after insert on public.coverage_offers
  for each row
  execute function public.route_coverage_customer_business_event();

drop trigger if exists coverage_requests_business_event_zz_route
  on public.coverage_requests;

create trigger coverage_requests_business_event_zz_route
  after insert on public.coverage_requests
  for each row
  execute function public.route_coverage_customer_business_event();

-- -----------------------------------------------------------------
-- Generic legacy fallback arbitration.
--
-- Any legacy notification already linked to an ACTIVE canonical Business Event
-- is no longer claimable by the historical outbox. This replaces the old
-- FX-specific routing condition and automatically applies to Coverage and any
-- future domain using legacy_notification_id during a strangler transition.
-- -----------------------------------------------------------------
create or replace function public.claim_customer_business_notifications(
  p_account_id uuid,
  p_change_request_id uuid default null,
  p_limit integer default 20
)
returns table(
  id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_text text,
  attempts integer,
  claim_token uuid,
  intent_id uuid,
  fx_trade_request_id uuid,
  event_type text,
  change_request_id uuid
)
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select cin.id
    from public.customer_intent_notifications as cin
    where cin.account_id = p_account_id
      and cin.status = 'pending'
      and cin.available_at <= pg_catalog.now()
      and (p_change_request_id is null or cin.change_request_id = p_change_request_id)
      and not exists (
        select 1
        from public.business_event_outbox as beo
        where beo.account_id = cin.account_id
          and beo.legacy_notification_id = cin.id
          and beo.delivery_mode = 'active'
      )
    order by cin.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ), claimed as (
    update public.customer_intent_notifications as cin
       set status = 'sending',
           claim_token = gen_random_uuid(),
           claimed_at = pg_catalog.now(),
           attempts = cin.attempts + 1,
           last_error = null
      from candidates as c
     where cin.id = c.id
    returning cin.id,
              cin.contact_id,
              cin.conversation_id,
              cin.message_text,
              cin.attempts,
              cin.claim_token,
              cin.intent_id,
              cin.fx_trade_request_id,
              cin.event_type,
              cin.change_request_id
  )
  select c.id,
         c.contact_id,
         c.conversation_id,
         c.message_text,
         c.attempts,
         c.claim_token,
         c.intent_id,
         c.fx_trade_request_id,
         c.event_type,
         c.change_request_id
  from claimed as c
  order by c.id;
$$;

revoke execute on function public.claim_customer_business_notifications(
  uuid, uuid, integer
) from public, anon, authenticated;

grant execute on function public.claim_customer_business_notifications(
  uuid, uuid, integer
) to service_role;

-- -----------------------------------------------------------------
-- Late legacy-link reconciliation.
--
-- Coverage's canonical event is created inside the authoritative Coverage-row
-- mutation, while the compatibility legacy row is inserted after Change Request
-- completion. If the canonical ACTIVE event was already sent, synchronize the
-- late legacy row immediately so rollback cannot resend it.
--
-- The trigger name starts with zz so the existing mirror trigger runs first and
-- attaches legacy_notification_id before this synchronization trigger executes.
-- -----------------------------------------------------------------
create or replace function public.sync_linked_active_business_event_legacy_sent()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  update public.customer_intent_notifications as cin
     set status = 'sent',
         local_message_id = coalesce(cin.local_message_id, beo.local_message_id),
         sent_at = coalesce(cin.sent_at, beo.sent_at, pg_catalog.now()),
         last_error = null,
         claim_token = null
    from public.business_event_outbox as beo
   where cin.account_id = new.account_id
     and cin.id = new.id
     and beo.account_id = new.account_id
     and beo.legacy_notification_id = new.id
     and beo.delivery_mode = 'active'
     and beo.status = 'sent'
     and cin.status <> 'sent';

  return new;
end;
$$;

revoke all on function public.sync_linked_active_business_event_legacy_sent()
  from public, anon, authenticated;

drop trigger if exists zz_customer_intent_notifications_business_event_sent_sync
  on public.customer_intent_notifications;

create trigger zz_customer_intent_notifications_business_event_sent_sync
  after insert on public.customer_intent_notifications
  for each row
  execute function public.sync_linked_active_business_event_legacy_sent();

-- -----------------------------------------------------------------
-- Coverage readiness.
-- Only customer-approved offer/request events participate in this route.
-- Internal lifecycle events stay shadow/internal and are not cutover blockers.
-- -----------------------------------------------------------------
create or replace function public.inspect_coverage_business_event_cutover_readiness(
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
        and c.route_key = 'coverage_customer_whatsapp'
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
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'coverage.offer.approved',
      'coverage.request.approved'
    ]::text[])
    and beo.shadow_projection_status = 'matched_legacy'
    and beo.legacy_notification_id is not null;

  select coalesce(
    array_agg(required.event_type order by required.event_type),
    array[]::text[]
  )
  into v_missing_keys
  from unnest(array[
    'coverage.offer.approved',
    'coverage.request.approved'
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
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'coverage.offer.approved',
      'coverage.request.approved'
    ]::text[])
    and beo.shadow_projection_status in ('pending', 'checking');

  select count(*)::integer
    into v_blockers
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'shadow'
     and beo.audience = 'customer'
     and beo.channel = 'whatsapp'
     and beo.event_type = any(array[
       'coverage.offer.approved',
       'coverage.request.approved'
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
     and cr.target_type in ('coverage_offer', 'coverage_request')
     and cin.status in ('pending', 'sending', 'requires_reconciliation');

  select count(*)::integer
    into v_active_nonterminal
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.event_type = any(array[
       'coverage.offer.approved',
       'coverage.request.approved'
     ]::text[])
     and beo.status in (
       'pending',
       'sending',
       'failed',
       'requires_reconciliation'
     );

  v_ready :=
    v_matched_event_types = 2
    and v_blockers = 0
    and v_legacy_nonterminal = 0
    and v_active_nonterminal = 0;

  return jsonb_build_object(
    'route_key', 'coverage_customer_whatsapp',
    'mode', v_mode,
    'ready', v_ready,
    'required_event_types', 2,
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

revoke execute on function public.inspect_coverage_business_event_cutover_readiness(uuid)
  from public, anon, authenticated;

grant execute on function public.inspect_coverage_business_event_cutover_readiness(uuid)
  to service_role;

-- -----------------------------------------------------------------
-- Explicit Coverage route switch with reversible fallback.
-- -----------------------------------------------------------------
create or replace function public.set_coverage_business_event_delivery_mode(
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
    raise exception 'COVERAGE_BUSINESS_EVENT_MODE_INVALID';
  end if;

  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = p_account_id
        and c.route_key = 'coverage_customer_whatsapp'
    ),
    'legacy'
  ) into v_current_mode;

  if v_current_mode = p_mode then
    return jsonb_build_object(
      'route_key', 'coverage_customer_whatsapp',
      'mode', v_current_mode,
      'changed', false
    );
  end if;

  if p_mode = 'active' then
    v_readiness :=
      public.inspect_coverage_business_event_cutover_readiness(p_account_id);

    if coalesce((v_readiness ->> 'ready')::boolean, false) is not true then
      raise exception 'COVERAGE_BUSINESS_EVENT_CUTOVER_NOT_READY:%',
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
      'coverage_customer_whatsapp',
      'active',
      pg_catalog.now(),
      pg_catalog.now()
    )
    on conflict (account_id, route_key) do update
      set mode = excluded.mode,
          updated_at = pg_catalog.now();

    return jsonb_build_object(
      'route_key', 'coverage_customer_whatsapp',
      'mode', 'active',
      'changed', true
    );
  end if;

  select count(*)::integer
    into v_inflight
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.event_type = any(array[
       'coverage.offer.approved',
       'coverage.request.approved'
     ]::text[])
     and beo.status in ('sending', 'requires_reconciliation');

  if v_inflight > 0 then
    raise exception 'COVERAGE_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT';
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
     and beo.event_type = any(array[
       'coverage.offer.approved',
       'coverage.request.approved'
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
     and beo.event_type = any(array[
       'coverage.offer.approved',
       'coverage.request.approved'
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
    'coverage_customer_whatsapp',
    'legacy',
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (account_id, route_key) do update
    set mode = excluded.mode,
        updated_at = pg_catalog.now();

  return jsonb_build_object(
    'route_key', 'coverage_customer_whatsapp',
    'mode', 'legacy',
    'changed', true,
    'demoted_unsent', v_demoted,
    'synced_legacy_sent', v_synced
  );
end;
$$;

revoke execute on function public.set_coverage_business_event_delivery_mode(uuid, text)
  from public, anon, authenticated;

grant execute on function public.set_coverage_business_event_delivery_mode(uuid, text)
  to service_role;
