-- ============================================================
-- 050_coverage_offers_requests.sql — Coverage marketplace
--                                     (Phase 2 §9 + §10)
--
-- Three tables plus a row-locking RPC that atomically reserves a
-- quantity from an offer against a request. The atomicity is the
-- critical guarantee: two concurrent matches racing for the last
-- unit of availability must not both succeed.
--
--   coverage_offers   — provider-side (party offering liquidity)
--   coverage_requests — requester-side (party needing liquidity)
--   coverage_matches  — link row with a reserved quantity and
--                        snapshots of the rate / fee in effect at
--                        booking time
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) coverage_offers
-- ------------------------------------------------------------
create table if not exists public.coverage_offers (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references accounts(id) on delete cascade,
  service_id          uuid not null references public.services(id) on delete restrict,
  -- The contact providing the liquidity. NOTE: the SAME contact
  -- may appear as provider on one offer and requester on another
  -- (the model is per-record, not per-contact — see plan §2).
  provider_contact_id uuid not null references public.contacts(id) on delete restrict,
  reference_code      text not null,
  total_amount        numeric(20, 4) not null check (total_amount > 0),
  reserved_amount     numeric(20, 4) not null default 0
                        check (reserved_amount >= 0),
  fulfilled_amount    numeric(20, 4) not null default 0
                        check (fulfilled_amount >= 0),
  currency            text not null,
  -- JSONB validated against the service's published schema
  -- version (see src/lib/services/catalog/field-schema-compiler.ts).
  attributes          jsonb not null default '{}'::jsonb,
  -- The provider's internal cost basis. NEVER exposed via public
  -- DTOs (Phase 2 §11). Stored separately so a price snapshot
  -- on the match is independent of the offer row.
  provider_cost       numeric(20, 4),
  provider_cost_currency text,
  available_from      timestamptz,
  expires_at          timestamptz,
  -- 'draft' | 'active' | 'partially_reserved' | 'fully_reserved'
  --   | 'fulfilled' | 'expired' | 'cancelled'.
  status              text not null default 'draft'
                        check (status in (
                          'draft', 'active', 'partially_reserved',
                          'fully_reserved', 'fulfilled', 'expired',
                          'cancelled'
                        )),
  version             bigint not null default 1,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Reserved + fulfilled cannot exceed total. Enforced at the
  -- service layer (atomic booking RPC) AND by a CHECK that's
  -- only meaningful when no row lock is held. SQL CHECKs can't
  -- see other rows, so the real guarantee is in the RPC.
  check (reserved_amount + fulfilled_amount <= total_amount)
);

create unique index if not exists coverage_offers_account_reference_uidx
  on public.coverage_offers (account_id, reference_code);

create index if not exists coverage_offers_account_service_status_idx
  on public.coverage_offers (account_id, service_id, status);

create index if not exists coverage_offers_account_currency_idx
  on public.coverage_offers (account_id, currency);

alter table public.coverage_offers enable row level security;

drop policy if exists coverage_offers_select on public.coverage_offers;
create policy coverage_offers_select on public.coverage_offers for select
  using (is_account_member(account_id));

drop policy if exists coverage_offers_insert on public.coverage_offers;
create policy coverage_offers_insert on public.coverage_offers for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists coverage_offers_update on public.coverage_offers;
create policy coverage_offers_update on public.coverage_offers for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists coverage_offers_delete on public.coverage_offers;
create policy coverage_offers_delete on public.coverage_offers for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_coverage_offers_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists coverage_offers_updated_at on public.coverage_offers;
create trigger coverage_offers_updated_at
  before update on public.coverage_offers
  for each row execute function public.update_coverage_offers_updated_at();

-- ------------------------------------------------------------
-- 2) coverage_requests
-- ------------------------------------------------------------
create table if not exists public.coverage_requests (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references accounts(id) on delete cascade,
  service_id          uuid not null references public.services(id) on delete restrict,
  requester_contact_id uuid not null references public.contacts(id) on delete restrict,
  requested_amount    numeric(20, 4) not null check (requested_amount > 0),
  reserved_amount     numeric(20, 4) not null default 0
                        check (reserved_amount >= 0),
  fulfilled_amount    numeric(20, 4) not null default 0
                        check (fulfilled_amount >= 0),
  currency            text not null,
  attributes          jsonb not null default '{}'::jsonb,
  -- Customer-facing quote snapshot. Filled when an admin/agent
  -- shares a quote with the requester. NULL until then.
  quote_snapshot      jsonb,
  expires_at          timestamptz,
  -- 'low' | 'normal' | 'high'.
  priority            text not null default 'normal'
                        check (priority in ('low', 'normal', 'high')),
  -- Free-text note visible to admins; never to requesters.
  notes               text,
  -- 'draft' | 'active' | 'partially_reserved' | 'fully_reserved'
  --   | 'fulfilled' | 'expired' | 'cancelled'.
  status              text not null default 'draft'
                        check (status in (
                          'draft', 'active', 'partially_reserved',
                          'fully_reserved', 'fulfilled', 'expired',
                          'cancelled'
                        )),
  version             bigint not null default 1,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (reserved_amount + fulfilled_amount <= requested_amount)
);

create index if not exists coverage_requests_account_service_status_idx
  on public.coverage_requests (account_id, service_id, status);

create index if not exists coverage_requests_account_currency_idx
  on public.coverage_requests (account_id, currency);

alter table public.coverage_requests enable row level security;

drop policy if exists coverage_requests_select on public.coverage_requests;
create policy coverage_requests_select on public.coverage_requests for select
  using (is_account_member(account_id));

drop policy if exists coverage_requests_insert on public.coverage_requests;
create policy coverage_requests_insert on public.coverage_requests for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists coverage_requests_update on public.coverage_requests;
create policy coverage_requests_update on public.coverage_requests for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists coverage_requests_delete on public.coverage_requests;
create policy coverage_requests_delete on public.coverage_requests for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_coverage_requests_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists coverage_requests_updated_at on public.coverage_requests;
create trigger coverage_requests_updated_at
  before update on public.coverage_requests
  for each row execute function public.update_coverage_requests_updated_at();

-- ------------------------------------------------------------
-- 3) coverage_matches
-- ------------------------------------------------------------
create table if not exists public.coverage_matches (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  offer_id          uuid not null references public.coverage_offers(id) on delete restrict,
  request_id        uuid not null references public.coverage_requests(id) on delete restrict,
  service_id        uuid not null references public.services(id) on delete restrict,
  matched_amount    numeric(20, 4) not null check (matched_amount > 0),
  currency          text not null,
  -- Snapshots: at booking time we capture the rate / fee / cost
  -- so the match is durable even if the offer/request rows change
  -- later (Phase 2 §9.3).
  rate_snapshot       jsonb not null default '{}'::jsonb,
  fee_snapshot        jsonb not null default '{}'::jsonb,
  provider_cost_snapshot numeric(20, 4),
  customer_fee_snapshot  numeric(20, 4),
  -- 'proposed' | 'reserved' | 'confirmed' | 'fulfilled'
  --   | 'released' | 'cancelled' | 'expired'.
  status            text not null default 'proposed'
                      check (status in (
                        'proposed', 'reserved', 'confirmed', 'fulfilled',
                        'released', 'cancelled', 'expired'
                      )),
  reserved_until    timestamptz,
  -- Idempotency key — the booking RPC refuses to create a
  -- second match row with the same (account, key) pair.
  idempotency_key   text not null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  confirmed_by      uuid references auth.users(id) on delete set null,
  confirmed_at      timestamptz,
  cancelled_by      uuid references auth.users(id) on delete set null,
  cancelled_at      timestamptz,
  fulfilled_at      timestamptz,
  released_at       timestamptz
);

create unique index if not exists coverage_matches_account_idempotency_uidx
  on public.coverage_matches (account_id, idempotency_key);

create index if not exists coverage_matches_account_offer_idx
  on public.coverage_matches (account_id, offer_id);

create index if not exists coverage_matches_account_request_idx
  on public.coverage_matches (account_id, request_id);

alter table public.coverage_matches enable row level security;

drop policy if exists coverage_matches_select on public.coverage_matches;
create policy coverage_matches_select on public.coverage_matches for select
  using (is_account_member(account_id));

drop policy if exists coverage_matches_insert on public.coverage_matches;
create policy coverage_matches_insert on public.coverage_matches for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists coverage_matches_update on public.coverage_matches;
create policy coverage_matches_update on public.coverage_matches for update
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4) Atomic reservation RPC
-- ------------------------------------------------------------
-- The critical concurrency primitive of Phase 2: reserves
-- `p_matched_amount` from an offer against a request inside ONE
-- transaction. Two concurrent callers racing for the last unit
-- MUST result in exactly one success.
--
-- Steps:
--   1. Validate account/currency/service consistency.
--   2. SELECT FOR UPDATE both rows in a stable order (offer then
--      request — by id) so the lock acquisition order matches
--      across callers (prevents deadlock).
--   3. Re-check offer availability + request remaining.
--   4. INSERT match with the idempotency_key (unique constraint).
--   5. UPDATE reserved_amount on both rows and bump statuses.
--   6. Audit.
-- ------------------------------------------------------------
create or replace function public.reserve_coverage_match(
  p_account_id      uuid,
  p_offer_id        uuid,
  p_request_id      uuid,
  p_matched_amount  numeric,
  p_currency        text,
  p_idempotency_key text,
  p_reserved_until  timestamptz,
  p_rate_snapshot   jsonb,
  p_fee_snapshot    jsonb,
  p_provider_cost   numeric,
  p_customer_fee    numeric,
  p_actor_user_id   uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer  public.coverage_offers%rowtype;
  v_req    public.coverage_requests%rowtype;
  v_offer_available numeric(20, 4);
  v_req_remaining   numeric(20, 4);
  v_new_offer_status text;
  v_new_req_status  text;
  v_match_id uuid;
begin
  if p_matched_amount <= 0 then
    raise exception 'COVERAGE_NON_POSITIVE_AMOUNT'
      using errcode = 'P0001';
  end if;

  -- Lock in a STABLE order (offer.id, request.id) to prevent
  -- deadlock between two workers booking different combinations.
  if p_offer_id < p_request_id then
    select * into v_offer from public.coverage_offers
     where id = p_offer_id and account_id = p_account_id
     for update;
    select * into v_req from public.coverage_requests
     where id = p_request_id and account_id = p_account_id
     for update;
  else
    select * into v_req from public.coverage_requests
     where id = p_request_id and account_id = p_account_id
     for update;
    select * into v_offer from public.coverage_offers
     where id = p_offer_id and account_id = p_account_id
     for update;
  end if;

  if v_offer.id is null then
    raise exception 'COVERAGE_OFFER_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_req.id is null then
    raise exception 'COVERAGE_REQUEST_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_offer.service_id <> v_req.service_id then
    raise exception 'COVERAGE_SERVICE_MISMATCH'
      using errcode = 'P0001';
  end if;
  if v_offer.currency <> p_currency or v_req.currency <> p_currency then
    raise exception 'COVERAGE_CURRENCY_MISMATCH'
      using errcode = 'P0001';
  end if;

  -- Re-check status (a row could have been cancelled between
  -- the caller's read and our lock).
  if v_offer.status not in ('active', 'partially_reserved', 'fully_reserved') then
    raise exception 'COVERAGE_OFFER_NOT_BOOKABLE'
      using errcode = 'P0001';
  end if;
  if v_req.status not in ('active', 'partially_reserved', 'fully_reserved') then
    raise exception 'COVERAGE_REQUEST_NOT_BOOKABLE'
      using errcode = 'P0001';
  end if;

  -- Compute remaining capacity INSIDE the transaction (defensive —
  -- the row-level CHECK is a sanity net, not a guarantee).
  v_offer_available := v_offer.total_amount - v_offer.reserved_amount - v_offer.fulfilled_amount;
  v_req_remaining   := v_req.requested_amount - v_req.reserved_amount - v_req.fulfilled_amount;

  if p_matched_amount > v_offer_available then
    raise exception 'COVERAGE_INSUFFICIENT_OFFER'
      using errcode = 'P0001';
  end if;
  if p_matched_amount > v_req_remaining then
    raise exception 'COVERAGE_INSUFFICIENT_REQUEST'
      using errcode = 'P0001';
  end if;

  -- Insert the match (idempotency_key unique index is the safety
  -- net against a duplicate call).
  insert into public.coverage_matches (
    account_id, offer_id, request_id, service_id,
    matched_amount, currency,
    rate_snapshot, fee_snapshot,
    provider_cost_snapshot, customer_fee_snapshot,
    status, reserved_until, idempotency_key, created_by
  ) values (
    p_account_id, p_offer_id, p_request_id, v_offer.service_id,
    p_matched_amount, p_currency,
    coalesce(p_rate_snapshot, '{}'::jsonb),
    coalesce(p_fee_snapshot, '{}'::jsonb),
    p_provider_cost, p_customer_fee,
    'reserved', p_reserved_until, p_idempotency_key, p_actor_user_id
  )
  returning id into v_match_id;

  -- Bump reserved amounts.
  update public.coverage_offers
     set reserved_amount = reserved_amount + p_matched_amount,
         version = version + 1
   where id = p_offer_id
     and version = v_offer.version
  returning status into v_new_offer_status;
  if v_new_offer_status is null then
    raise exception 'COVERAGE_OFFER_VERSION_CONFLICT'
      using errcode = 'P0001';
  end if;

  update public.coverage_requests
     set reserved_amount = reserved_amount + p_matched_amount,
         version = version + 1
   where id = p_request_id
     and version = v_req.version
  returning status into v_new_req_status;
  if v_new_req_status is null then
    raise exception 'COVERAGE_REQUEST_VERSION_CONFLICT'
      using errcode = 'P0001';
  end if;

  -- Recompute statuses from the post-update state.
  if (v_offer.total_amount - v_offer.reserved_amount - p_matched_amount - v_offer.fulfilled_amount) = 0 then
    update public.coverage_offers
       set status = 'fully_reserved'
     where id = p_offer_id;
  else
    update public.coverage_offers
       set status = 'partially_reserved'
     where id = p_offer_id
       and status = 'active';
  end if;

  if (v_req.requested_amount - v_req.reserved_amount - p_matched_amount - v_req.fulfilled_amount) = 0 then
    update public.coverage_requests
       set status = 'fully_reserved'
     where id = p_request_id;
  else
    update public.coverage_requests
       set status = 'partially_reserved'
     where id = p_request_id
       and status = 'active';
  end if;

  -- Audit.
  perform public.append_service_activity_event(
    p_account_id,
    'coverage_match',
    v_match_id,
    'coverage.match.reserved',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object(
      'offer_id', p_offer_id,
      'request_id', p_request_id,
      'matched_amount', p_matched_amount,
      'currency', p_currency
    )
  );

  return v_match_id;
end;
$$;

revoke all on function public.reserve_coverage_match(
  uuid, uuid, uuid, numeric, text, text, timestamptz,
  jsonb, jsonb, numeric, numeric, uuid
) from public;
grant execute on function public.reserve_coverage_match(
  uuid, uuid, uuid, numeric, text, text, timestamptz,
  jsonb, jsonb, numeric, numeric, uuid
) to service_role;

-- ------------------------------------------------------------
-- 5) Release reservation RPC
-- ------------------------------------------------------------
-- Idempotent release. Two callers racing to release the SAME
-- match result in exactly one row update.
create or replace function public.release_coverage_match(
  p_account_id     uuid,
  p_match_id       uuid,
  p_actor_user_id  uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match  public.coverage_matches%rowtype;
  v_offer  public.coverage_offers%rowtype;
  v_offer_new_reserved numeric(20, 4);
begin
  select * into v_match from public.coverage_matches
   where id = p_match_id and account_id = p_account_id
   for update;
  if v_match.id is null then
    raise exception 'COVERAGE_MATCH_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_match.status in ('released', 'cancelled', 'expired', 'fulfilled') then
    -- Idempotent: already terminal. Return without an error.
    return;
  end if;

  select * into v_offer from public.coverage_offers
   where id = v_match.offer_id and account_id = p_account_id
   for update;

  update public.coverage_matches
     set status = 'released',
         released_at = now()
   where id = p_match_id
     and status = v_match.status;

  v_offer_new_reserved := v_offer.reserved_amount - v_match.matched_amount;
  if v_offer_new_reserved < 0 then
    v_offer_new_reserved := 0;
  end if;

  update public.coverage_offers
     set reserved_amount = v_offer_new_reserved,
         version = version + 1,
         status = case
           when v_offer_new_reserved = 0 and v_offer.fulfilled_amount = 0 then 'active'
           when v_offer_new_reserved = 0 then 'active'
           else 'partially_reserved'
         end
   where id = v_match.offer_id;

  update public.coverage_requests
     set reserved_amount = greatest(reserved_amount - v_match.matched_amount, 0),
         version = version + 1
   where id = v_match.request_id;

  perform public.append_service_activity_event(
    p_account_id,
    'coverage_match',
    p_match_id,
    'coverage.match.released',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('offer_id', v_match.offer_id, 'request_id', v_match.request_id)
  );
end;
$$;

revoke all on function public.release_coverage_match(
  uuid, uuid, uuid
) from public;
grant execute on function public.release_coverage_match(
  uuid, uuid, uuid
) to service_role;
