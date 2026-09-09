-- ============================================================
-- 057_customer_intents.sql — General service-intent memory
--                              (post-Phase-5 capability)
--
-- Problem this solves (real workflow, owner request):
--   An agent chats with a customer who wants a service the
--   platform has NOT equipped yet (e.g. outward remittance to
--   Kuala Lumpur). The equipped schema cannot express the
--   request, and the agent must never invent fields or prices.
--
-- Design:
--   customer_intents — a GENERAL, free-shape memory row per
--   customer need (offer or request), carrying what the agent
--   understood in `attributes` (JSONB) plus a human summary.
--   Intents are the durable "notes" layer that survives until
--   the service gets equipped, at which point they can be linked
--   via `matched_service_id` and worked normally.
--
-- Lifecycle:
--   new → clarifying → forwarded_to_admin → fulfilled | rejected
--                              └→ matched (service equipped)
--
-- The escalation to the admin goes through the existing
-- change_requests engine (target_type='service_intent',
-- intent='create'), so approval semantics, confirmation codes,
-- expiry, and audit stay uniform.
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists public.customer_intents (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  conversation_id   uuid references public.conversations(id) on delete set null,
  -- 'offer' (customer provides the service/liquidity) or
  -- 'request' (customer needs the service). Mirrors the
  -- coverage model so a later match can use the same roles.
  direction         text not null
                      check (direction in ('offer', 'request')),
  -- What the agent believed the service to be, e.g.
  -- "outward remittance to Kuala Lumpur". Free text BY DESIGN:
  -- the request may not map to any equipped service yet.
  service_hint      text not null,
  -- Agent-drafted human summary for the admin review.
  summary           text,
  -- Closed lifecycle (see header).
  status            text not null default 'new'
                      check (status in (
                        'new', 'clarifying', 'forwarded_to_admin',
                        'fulfilled', 'rejected', 'matched'
                      )),
  -- What the agent understood, free-shape. Validated only for
  -- size + JSON-ness; never merged into an equipped schema.
  attributes        jsonb not null default '{}'::jsonb,
  -- Set when a matching service is later equipped and linked.
  matched_service_id uuid references public.services(id) on delete set null,
  -- Set when the escalation change request is created.
  change_request_id uuid references public.change_requests(id) on delete set null,
  -- Idempotency for repeated agent attempts on the same
  -- conversation + service hint.
  idempotency_key   text not null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Soft caps so a runaway agent cannot bloat the table.
  check (char_length(service_hint) between 1 and 300),
  check (char_length(coalesce(summary, '')) <= 2000)
);

create unique index if not exists customer_intents_account_idem_uidx
  on public.customer_intents (account_id, idempotency_key);

create index if not exists customer_intents_account_status_idx
  on public.customer_intents (account_id, status, created_at desc);

create index if not exists customer_intents_contact_idx
  on public.customer_intents (account_id, contact_id, created_at desc);

alter table public.customer_intents enable row level security;

drop policy if exists customer_intents_select on public.customer_intents;
create policy customer_intents_select on public.customer_intents for select
  using (is_account_member(account_id));

drop policy if exists customer_intents_insert on public.customer_intents;
create policy customer_intents_insert on public.customer_intents for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists customer_intents_update on public.customer_intents;
create policy customer_intents_update on public.customer_intents for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy — intents are audit history (like revisions).

create or replace function public.update_customer_intents_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists customer_intents_updated_at on public.customer_intents;
create trigger customer_intents_updated_at
  before update on public.customer_intents
  for each row execute function public.update_customer_intents_updated_at();

-- ------------------------------------------------------------
-- Extend the change_requests target vocabulary so agent
-- escalations of unequipped service needs flow through the
-- SAME approval engine (same codes, expiry, audit).
-- ------------------------------------------------------------
alter table public.change_requests
  drop constraint if exists change_requests_target_type_check;

-- Re-declare the widened check. Keep the original values first
-- so existing rows remain valid.
alter table public.change_requests
  add constraint change_requests_target_type_check
  check (target_type in (
    'service',
    'service_revision',
    'pricing_rule',
    'rate_book_version',
    'coverage_offer',
    'coverage_request',
    'service_intent'
  ));

-- ------------------------------------------------------------
-- Atomic intent creation used by the agent runtime (service
-- role). Idempotent on (account_id, idempotency_key).
-- ------------------------------------------------------------
create or replace function public.create_customer_intent(
  p_account_id      uuid,
  p_contact_id      uuid,
  p_conversation_id uuid,
  p_direction       text,
  p_service_hint    text,
  p_summary         text,
  p_attributes      jsonb,
  p_idempotency_key text,
  p_actor_user_id   uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_new uuid;
begin
  if p_direction not in ('offer', 'request') then
    raise exception 'INTENT_INVALID_DIRECTION' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 12 then
    raise exception 'INTENT_INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;

  select id into v_existing
    from public.customer_intents
   where account_id = p_account_id
     and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.customer_intents (
    account_id, contact_id, conversation_id, direction,
    service_hint, summary, status, attributes,
    idempotency_key, created_by
  ) values (
    p_account_id, p_contact_id, p_conversation_id, p_direction,
    p_service_hint, p_summary, 'new',
    coalesce(p_attributes, '{}'::jsonb),
    p_idempotency_key, p_actor_user_id
  )
  returning id into v_new;

  perform public.append_service_activity_event(
    p_account_id,
    'customer_intent',
    v_new,
    'customer_intent.created',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('direction', p_direction, 'service_hint', p_service_hint)
  );

  return v_new;
end;
$$;

revoke all on function public.create_customer_intent(
  uuid, uuid, uuid, text, text, text, jsonb, text, uuid
) from public;
grant execute on function public.create_customer_intent(
  uuid, uuid, uuid, text, text, text, jsonb, text, uuid
) to service_role;

-- ------------------------------------------------------------
-- Service-role RPC: link an intent to a service once equipped
-- (status='matched'). Called by the deterministic executor when
-- an admin approves equipping a service for an old intent.
-- ------------------------------------------------------------
create or replace function public.match_customer_intent(
  p_account_id uuid,
  p_intent_id  uuid,
  p_service_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.customer_intents
     set matched_service_id = p_service_id,
         status = 'matched'
   where id = p_intent_id
     and account_id = p_account_id
     and status in ('new', 'clarifying', 'forwarded_to_admin')
  returning status into v_status;
  if v_status is null then
    raise exception 'INTENT_NOT_MATCHABLE' using errcode = 'P0001';
  end if;
  perform public.append_service_activity_event(
    p_account_id,
    'customer_intent',
    p_intent_id,
    'customer_intent.matched',
    'system',
    '',
    jsonb_build_object('service_id', p_service_id)
  );
  return v_status;
end;
$$;

revoke all on function public.match_customer_intent(uuid, uuid, uuid) from public;
grant execute on function public.match_customer_intent(uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- Seed the suggested tool keys on the two relevant templates so
-- new agents built from them get the matching tools.
-- ------------------------------------------------------------
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys
         || '["services.match_request","intents.record","intents.search"]'::jsonb
 where system_template_key in ('customer_service', 'services_pricing', 'coverage')
   and not (suggested_tool_keys ?| array[
     'services.match_request', 'intents.record', 'intents.search'
   ]);
