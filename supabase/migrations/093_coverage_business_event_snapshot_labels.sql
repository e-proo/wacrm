-- ============================================================
-- 093_coverage_business_event_snapshot_labels.sql
-- Phase F prerequisite: make Coverage embedded-event snapshots self-contained
-- for customer message projection.
--
-- Migration 090 stored the immutable Coverage business facts but retained
-- region ids inside attributes. Region display names are mutable catalog data,
-- so future events now freeze the labels at event time as well.
--
-- No existing outbox rows are rewritten: historical facts must never be
-- reconstructed from current mutable region names.
-- ============================================================

create or replace function public.enqueue_coverage_offer_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_intent_id uuid;
  v_conversation_id uuid;
  v_actor_id text;
  v_audience text;
  v_channel text;
  v_dedupe_key text;
  v_pay_region_label text;
  v_receive_region_label text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and new.source_change_request_id is not null then
      v_event_type := 'coverage.offer.approved';
      v_actor_id := new.created_by::text;
      v_audience := 'customer';
      v_channel := 'whatsapp';
    elsif new.status = 'active' then
      v_event_type := 'coverage.offer.activated';
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'active' then
      v_event_type := 'coverage.offer.activated';
    elsif new.status = 'cancelled' then
      v_event_type := 'coverage.offer.cancelled';
    elsif new.status = 'fulfilled' then
      v_event_type := 'coverage.offer.fulfilled';
    elsif new.status = 'expired' then
      v_event_type := 'coverage.offer.expired';
    end if;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.source_change_request_id is not null then
    select ci.id, ci.conversation_id
      into v_intent_id, v_conversation_id
      from public.change_requests as cr
      left join public.customer_intents as ci
        on ci.account_id = new.account_id
       and ci.id::text = cr.proposed_payload ->> 'intent_id'
     where cr.account_id = new.account_id
       and cr.id = new.source_change_request_id;
  end if;

  if nullif(new.attributes ->> 'pay_region_id', '') is not null then
    select coalesce(nullif(cr.name, ''), nullif(cr.code, ''), cr.id::text)
      into v_pay_region_label
      from public.coverage_regions as cr
     where cr.account_id = new.account_id
       and cr.id::text = new.attributes ->> 'pay_region_id';
  end if;

  if nullif(new.attributes ->> 'receive_region_id', '') is not null then
    select coalesce(nullif(cr.name, ''), nullif(cr.code, ''), cr.id::text)
      into v_receive_region_label
      from public.coverage_regions as cr
     where cr.account_id = new.account_id
       and cr.id::text = new.attributes ->> 'receive_region_id';
  end if;

  v_pay_region_label := coalesce(
    v_pay_region_label,
    nullif(new.attributes ->> 'coverage_country', ''),
    'غير محدد'
  );
  v_receive_region_label := coalesce(
    v_receive_region_label,
    nullif(new.attributes ->> 'coverage_country', ''),
    'غير محدد'
  );

  v_dedupe_key :=
    v_event_type || ':v1:coverage_offer:' || new.id::text;

  insert into public.business_event_outbox as beo (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    audience,
    channel,
    contact_id,
    conversation_id,
    correlation_id,
    causation_id,
    payload,
    delivery_mode,
    status,
    dedupe_key
  ) values (
    new.account_id,
    v_event_type,
    1,
    'coverage_offer',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    v_audience,
    v_channel,
    case when v_audience = 'customer' then new.provider_contact_id else null end,
    case when v_audience = 'customer' then v_conversation_id else null end,
    new.source_change_request_id::text,
    v_intent_id::text,
    jsonb_build_object(
      'service_id', new.service_id,
      'reference', new.reference_code,
      'amount', new.total_amount::text,
      'currency', new.currency,
      'attributes', new.attributes,
      'pay_region_label', v_pay_region_label,
      'receive_region_label', v_receive_region_label,
      'commission_per_thousand',
        case when new.commission_per_thousand is null
          then null else new.commission_per_thousand::text end,
      'commission_amount',
        case when new.commission_amount is null
          then null else new.commission_amount::text end,
      'commission_currency', new.commission_currency,
      'deal_date', new.deal_date::text,
      'status_after', new.status,
      'version', new.version
    ),
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_coverage_offer_business_event_shadow()
  from public, anon, authenticated;

create or replace function public.enqueue_coverage_request_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_intent_id uuid;
  v_conversation_id uuid;
  v_actor_id text;
  v_audience text;
  v_channel text;
  v_dedupe_key text;
  v_pay_region_label text;
  v_receive_region_label text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and new.source_change_request_id is not null then
      v_event_type := 'coverage.request.approved';
      v_actor_id := new.created_by::text;
      v_audience := 'customer';
      v_channel := 'whatsapp';
    elsif new.status = 'active' then
      v_event_type := 'coverage.request.activated';
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'active' then
      v_event_type := 'coverage.request.activated';
    elsif new.status = 'cancelled' then
      v_event_type := 'coverage.request.cancelled';
    elsif new.status = 'fulfilled' then
      v_event_type := 'coverage.request.fulfilled';
    elsif new.status = 'expired' then
      v_event_type := 'coverage.request.expired';
    end if;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.source_change_request_id is not null then
    select ci.id, ci.conversation_id
      into v_intent_id, v_conversation_id
      from public.change_requests as cr
      left join public.customer_intents as ci
        on ci.account_id = new.account_id
       and ci.id::text = cr.proposed_payload ->> 'intent_id'
     where cr.account_id = new.account_id
       and cr.id = new.source_change_request_id;
  end if;

  if nullif(new.attributes ->> 'pay_region_id', '') is not null then
    select coalesce(nullif(cr.name, ''), nullif(cr.code, ''), cr.id::text)
      into v_pay_region_label
      from public.coverage_regions as cr
     where cr.account_id = new.account_id
       and cr.id::text = new.attributes ->> 'pay_region_id';
  end if;

  if nullif(new.attributes ->> 'receive_region_id', '') is not null then
    select coalesce(nullif(cr.name, ''), nullif(cr.code, ''), cr.id::text)
      into v_receive_region_label
      from public.coverage_regions as cr
     where cr.account_id = new.account_id
       and cr.id::text = new.attributes ->> 'receive_region_id';
  end if;

  v_pay_region_label := coalesce(
    v_pay_region_label,
    nullif(new.attributes ->> 'coverage_country', ''),
    'غير محدد'
  );
  v_receive_region_label := coalesce(
    v_receive_region_label,
    nullif(new.attributes ->> 'coverage_country', ''),
    'غير محدد'
  );

  v_dedupe_key :=
    v_event_type || ':v1:coverage_request:' || new.id::text;

  insert into public.business_event_outbox as beo (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    audience,
    channel,
    contact_id,
    conversation_id,
    correlation_id,
    causation_id,
    payload,
    delivery_mode,
    status,
    dedupe_key
  ) values (
    new.account_id,
    v_event_type,
    1,
    'coverage_request',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    v_audience,
    v_channel,
    case when v_audience = 'customer' then new.requester_contact_id else null end,
    case when v_audience = 'customer' then v_conversation_id else null end,
    new.source_change_request_id::text,
    v_intent_id::text,
    jsonb_build_object(
      'service_id', new.service_id,
      'amount', new.requested_amount::text,
      'currency', new.currency,
      'attributes', new.attributes,
      'pay_region_label', v_pay_region_label,
      'receive_region_label', v_receive_region_label,
      'commission_per_thousand',
        case when new.commission_per_thousand is null
          then null else new.commission_per_thousand::text end,
      'commission_amount',
        case when new.commission_amount is null
          then null else new.commission_amount::text end,
      'commission_currency', new.commission_currency,
      'deal_date', new.deal_date::text,
      'status_after', new.status,
      'version', new.version
    ),
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_coverage_request_business_event_shadow()
  from public, anon, authenticated;
