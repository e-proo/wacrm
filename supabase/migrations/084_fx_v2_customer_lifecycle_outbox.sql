-- ============================================================
-- 084_fx_v2_customer_lifecycle_outbox.sql
-- Durable FX V2 customer lifecycle events on the existing customer
-- notification outbox. The historical table name is retained for
-- compatibility; rows now belong to exactly one source entity:
-- customer_intent OR exchange_trade_request.
--
-- FX financial facts are NOT rendered in SQL. This migration records the
-- stable business event atomically with the authoritative trade transition;
-- the application worker loads the immutable trade snapshot and renders it
-- through the existing MessageContext -> resolver -> renderer platform.
-- ============================================================

alter table public.customer_intent_notifications
  add column if not exists fx_trade_request_id uuid
    references public.exchange_trade_requests(id) on delete cascade;

-- Legacy intent notifications keep their existing behavior, while FX rows use
-- fx_trade_request_id instead. Exactly one source entity is required below.
alter table public.customer_intent_notifications
  alter column intent_id drop not null;

alter table public.customer_intent_notifications
  drop constraint if exists customer_intent_notifications_event_type_check;

alter table public.customer_intent_notifications
  add constraint customer_intent_notifications_event_type_check
  check (event_type in (
    'approved_and_applied',
    'rejected',
    'needs_clarification',
    'matched',
    'exchange_rate.trade.pending',
    'exchange_rate.trade.approved_for_contact',
    'exchange_rate.trade.rejected',
    'exchange_rate.trade.completed'
  ));

alter table public.customer_intent_notifications
  drop constraint if exists customer_intent_notifications_source_entity_check;

alter table public.customer_intent_notifications
  add constraint customer_intent_notifications_source_entity_check
  check (
    (intent_id is not null and fx_trade_request_id is null)
    or
    (intent_id is null and fx_trade_request_id is not null)
  );

-- Keep the legacy regular UNIQUE index untouched: the existing PostgREST
-- upsert uses it as an ON CONFLICT target. FX gets a separate regular UNIQUE
-- index for the same reason. NULLs are allowed for non-FX rows.
create unique index if not exists customer_intent_notifications_fx_trade_once_uidx
  on public.customer_intent_notifications (
    account_id,
    fx_trade_request_id,
    event_type
  );

create index if not exists customer_intent_notifications_fx_trade_idx
  on public.customer_intent_notifications (
    account_id,
    fx_trade_request_id,
    created_at desc
  )
  where fx_trade_request_id is not null;

comment on column public.customer_intent_notifications.fx_trade_request_id is
  'FX V2 source entity. Financial message facts are loaded from the referenced immutable trade snapshot at delivery time.';

comment on table public.customer_intent_notifications is
  'Durable customer outcome outbox. Historical name retained; a row belongs to exactly one customer_intent or FX V2 trade request.';

-- -----------------------------------------------------------------
-- Existing intent-specific atomic claim must never claim FX rows. This keeps
-- older change-request delivery code from sending the internal FX render marker.
-- The general worker handles FX rows and renders them from authoritative state.
-- -----------------------------------------------------------------
create or replace function public.claim_customer_intent_notifications(
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
  claim_token uuid
)
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select cin.id
    from public.customer_intent_notifications as cin
    where cin.account_id = p_account_id
      and cin.fx_trade_request_id is null
      and cin.status = 'pending'
      and cin.available_at <= pg_catalog.now()
      and (p_change_request_id is null or cin.change_request_id = p_change_request_id)
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
              cin.claim_token
  )
  select c.id,
         c.contact_id,
         c.conversation_id,
         c.message_text,
         c.attempts,
         c.claim_token
  from claimed as c
  order by c.id;
$$;

revoke execute on function public.claim_customer_intent_notifications(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_customer_intent_notifications(uuid, uuid, integer)
  to service_role;

-- -----------------------------------------------------------------
-- Business event -> durable outbox adapter.
-- AFTER trigger means the row already contains the exact frozen financial
-- snapshot and authoritative lifecycle status. An insert failure rolls the
-- trade transaction back, eliminating the mutation/outbox split-brain window.
-- -----------------------------------------------------------------
create or replace function public.enqueue_fx_trade_customer_lifecycle_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_change_request_id uuid;
begin
  -- A trade without a routable customer conversation is still valid business
  -- state, but there is no customer transport destination to enqueue.
  if new.contact_id is null or new.conversation_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending_admin' then
      v_event_type := 'exchange_rate.trade.pending';
    end if;
  elsif new.status is distinct from old.status then
    v_event_type := case new.status
      when 'pending_admin' then 'exchange_rate.trade.pending'
      when 'approved_for_contact' then 'exchange_rate.trade.approved_for_contact'
      when 'rejected' then 'exchange_rate.trade.rejected'
      when 'completed' then 'exchange_rate.trade.completed'
      else null
    end;
  elsif (old.contact_id is null or old.conversation_id is null)
        and new.contact_id is not null
        and new.conversation_id is not null then
    -- Defensive support for a future trusted server path that attaches routing
    -- after creation. Emit only the current authoritative state, not invented
    -- historical states.
    v_event_type := case new.status
      when 'pending_admin' then 'exchange_rate.trade.pending'
      when 'approved_for_contact' then 'exchange_rate.trade.approved_for_contact'
      when 'rejected' then 'exchange_rate.trade.rejected'
      when 'completed' then 'exchange_rate.trade.completed'
      else null
    end;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.status in ('approved_for_contact', 'rejected') then
    v_change_request_id := new.decision_change_request_id;
  end if;

  insert into public.customer_intent_notifications (
    account_id,
    intent_id,
    fx_trade_request_id,
    change_request_id,
    contact_id,
    conversation_id,
    event_type,
    message_text,
    status
  ) values (
    new.account_id,
    null,
    new.id,
    v_change_request_id,
    new.contact_id,
    new.conversation_id,
    v_event_type,
    '__FX_V2_RENDER_AT_DELIVERY__',
    'pending'
  )
  on conflict (account_id, fx_trade_request_id, event_type) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_fx_trade_customer_lifecycle_event()
  from public, anon, authenticated;

drop trigger if exists exchange_trade_requests_customer_lifecycle_event
  on public.exchange_trade_requests;

create trigger exchange_trade_requests_customer_lifecycle_event
  after insert or update of status, contact_id, conversation_id
  on public.exchange_trade_requests
  for each row
  execute function public.enqueue_fx_trade_customer_lifecycle_event();
