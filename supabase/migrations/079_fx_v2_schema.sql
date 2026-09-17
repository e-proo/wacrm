-- ============================================================
-- 079_fx_v2_schema.sql — Pair-centric FX V2 foundation
--
-- Purpose:
--   Replace the business model of rate books with explicit currency
--   pairs and immutable published versions, without deleting or
--   mutating the legacy FX tables yet.
--
-- Existing public.currencies is intentionally reused. It is already
-- account-scoped and protected by RLS, so a second account-currency
-- mapping table would only duplicate state.
--
-- Phase 1 creates only the durable data model and security boundary.
-- Runtime/domain services, dashboard, AI tools and messaging migrate
-- to these tables in later phases.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Tenant-safe composite reference support for currencies
-- ------------------------------------------------------------
-- currencies.id is already globally unique. This additional unique
-- index lets child tables enforce that a currency belongs to the same
-- account as the FX object referencing it.
create unique index if not exists currencies_account_id_id_uidx
  on public.currencies (account_id, id);

-- ------------------------------------------------------------
-- 1) Account FX settings
-- ------------------------------------------------------------
-- A row exists only after FX is explicitly configured for an account.
-- We deliberately do NOT copy accounts.default_currency here: that
-- field controls CRM/deal display and is a different business concern.
create table if not exists public.account_exchange_settings (
  account_id        uuid primary key references public.accounts(id) on delete cascade,
  base_currency_id  uuid not null,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint account_exchange_settings_base_currency_fk
    foreign key (account_id, base_currency_id)
    references public.currencies(account_id, id)
    on delete restrict
);

create index if not exists account_exchange_settings_base_currency_idx
  on public.account_exchange_settings (base_currency_id);

alter table public.account_exchange_settings enable row level security;

drop policy if exists account_exchange_settings_select on public.account_exchange_settings;
create policy account_exchange_settings_select
  on public.account_exchange_settings for select
  using (is_account_member(account_id));

drop policy if exists account_exchange_settings_insert on public.account_exchange_settings;
create policy account_exchange_settings_insert
  on public.account_exchange_settings for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists account_exchange_settings_update on public.account_exchange_settings;
create policy account_exchange_settings_update
  on public.account_exchange_settings for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

drop policy if exists account_exchange_settings_delete on public.account_exchange_settings;
create policy account_exchange_settings_delete
  on public.account_exchange_settings for delete
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 2) Explicit FX pairs
-- ------------------------------------------------------------
create table if not exists public.exchange_rate_pairs (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts(id) on delete cascade,
  base_currency_id         uuid not null,
  quote_currency_id        uuid not null,
  status                   text not null default 'active'
                             check (status in ('active', 'archived')),
  current_rate_version_id  uuid,
  -- Optimistic-concurrency token for mutable pair state. This is
  -- intentionally distinct from exchange_rate_versions.version_number.
  lock_version             bigint not null default 0 check (lock_version >= 0),
  created_by               uuid references auth.users(id) on delete set null,
  updated_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint exchange_rate_pairs_distinct_currencies_chk
    check (base_currency_id <> quote_currency_id),
  constraint exchange_rate_pairs_base_currency_fk
    foreign key (account_id, base_currency_id)
    references public.currencies(account_id, id)
    on delete restrict,
  constraint exchange_rate_pairs_quote_currency_fk
    foreign key (account_id, quote_currency_id)
    references public.currencies(account_id, id)
    on delete restrict,
  constraint exchange_rate_pairs_account_id_id_uniq
    unique (account_id, id),
  constraint exchange_rate_pairs_account_pair_uniq
    unique (account_id, base_currency_id, quote_currency_id)
);

create index if not exists exchange_rate_pairs_account_status_idx
  on public.exchange_rate_pairs (account_id, status);
create index if not exists exchange_rate_pairs_base_currency_idx
  on public.exchange_rate_pairs (account_id, base_currency_id);
create index if not exists exchange_rate_pairs_quote_currency_idx
  on public.exchange_rate_pairs (account_id, quote_currency_id);

alter table public.exchange_rate_pairs enable row level security;

drop policy if exists exchange_rate_pairs_select on public.exchange_rate_pairs;
create policy exchange_rate_pairs_select
  on public.exchange_rate_pairs for select
  using (is_account_member(account_id));

drop policy if exists exchange_rate_pairs_insert on public.exchange_rate_pairs;
create policy exchange_rate_pairs_insert
  on public.exchange_rate_pairs for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rate_pairs_update on public.exchange_rate_pairs;
create policy exchange_rate_pairs_update
  on public.exchange_rate_pairs for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

-- Deliberately no DELETE policy. A pair with history is archived, not
-- deleted, so immutable versions and trade references remain stable.

-- ------------------------------------------------------------
-- 3) Immutable published rate versions
-- ------------------------------------------------------------
create table if not exists public.exchange_rate_versions (
  id                        uuid primary key default gen_random_uuid(),
  account_id                uuid not null references public.accounts(id) on delete cascade,
  pair_id                   uuid not null,
  version_number            integer not null check (version_number > 0),
  business_buy_rate         numeric(24, 8) not null check (business_buy_rate > 0),
  business_sell_rate        numeric(24, 8) not null check (business_sell_rate > 0),
  source                    text not null default 'manual'
                              check (source in ('manual', 'admin_agent', 'external', 'migration')),
  source_change_request_id  uuid references public.change_requests(id) on delete set null,
  notes_internal            text,
  created_by                uuid references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  published_at              timestamptz not null default now(),

  constraint exchange_rate_versions_pair_fk
    foreign key (account_id, pair_id)
    references public.exchange_rate_pairs(account_id, id)
    on delete cascade,
  constraint exchange_rate_versions_pair_number_uniq
    unique (pair_id, version_number),
  constraint exchange_rate_versions_pair_id_id_uniq
    unique (pair_id, id)
);

create index if not exists exchange_rate_versions_account_pair_published_idx
  on public.exchange_rate_versions (account_id, pair_id, published_at desc);
create unique index if not exists exchange_rate_versions_change_request_uidx
  on public.exchange_rate_versions (source_change_request_id)
  where source_change_request_id is not null;

alter table public.exchange_rate_versions enable row level security;

drop policy if exists exchange_rate_versions_select on public.exchange_rate_versions;
create policy exchange_rate_versions_select
  on public.exchange_rate_versions for select
  using (is_account_member(account_id));

-- No authenticated INSERT/UPDATE/DELETE policies on purpose. Rate
-- publication will be performed by a deterministic service-role RPC
-- in the domain-service phase. Versions are append-only through the
-- application boundary; no mutation path is exposed to authenticated
-- clients. We intentionally avoid a DELETE-blocking trigger so account
-- deletion/cascade semantics remain valid.

-- The current pointer must always point to a version belonging to the
-- same pair. This composite FK prevents accidental cross-pair pointers.
alter table public.exchange_rate_pairs
  drop constraint if exists exchange_rate_pairs_current_rate_version_fk;
alter table public.exchange_rate_pairs
  add constraint exchange_rate_pairs_current_rate_version_fk
  foreign key (id, current_rate_version_id)
  references public.exchange_rate_versions(pair_id, id)
  on delete restrict
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 4) Customer FX trade requests
-- ------------------------------------------------------------
-- `side` is always relative to the pair BASE currency:
--   customer_buy  => customer buys base from business; use business_sell_rate
--   customer_sell => customer sells base to business; use business_buy_rate
--
-- `amount_basis` records whether the amount the customer stated was in
-- the base or quote currency. Both calculated amounts and the exact rate
-- version are snapshotted so later price changes cannot rewrite history.
create table if not exists public.exchange_trade_requests (
  id                          uuid primary key default gen_random_uuid(),
  code                        bigint generated by default as identity unique,
  account_id                  uuid not null references public.accounts(id) on delete cascade,
  pair_id                     uuid not null,
  side                        text not null
                                check (side in ('customer_buy', 'customer_sell')),
  amount_basis                text not null
                                check (amount_basis in ('base', 'quote')),
  requested_amount            numeric(24, 8) not null check (requested_amount > 0),
  rate_version_id             uuid not null,
  effective_rate              numeric(24, 8) not null check (effective_rate > 0),
  base_amount                 numeric(24, 8) not null check (base_amount > 0),
  quote_amount                numeric(24, 8) not null check (quote_amount > 0),
  status                      text not null default 'pending_admin'
                                check (status in (
                                  'pending_admin',
                                  'approved_for_contact',
                                  'rejected',
                                  'completed',
                                  'cancelled'
                                )),
  idempotency_key             text not null check (length(btrim(idempotency_key)) > 0),
  contact_id                  uuid references public.contacts(id) on delete set null,
  conversation_id             uuid references public.conversations(id) on delete set null,
  decision_change_request_id  uuid references public.change_requests(id) on delete set null,
  decision_note               text,
  decided_by                  uuid references auth.users(id) on delete set null,
  decided_at                  timestamptz,
  completed_at                timestamptz,
  cancelled_at                timestamptz,
  metadata                    jsonb not null default '{}'::jsonb
                                check (jsonb_typeof(metadata) = 'object'),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint exchange_trade_requests_pair_fk
    foreign key (account_id, pair_id)
    references public.exchange_rate_pairs(account_id, id)
    on delete restrict,
  constraint exchange_trade_requests_rate_version_fk
    foreign key (pair_id, rate_version_id)
    references public.exchange_rate_versions(pair_id, id)
    on delete restrict,
  constraint exchange_trade_requests_account_idempotency_uniq
    unique (account_id, idempotency_key)
);

create index if not exists exchange_trade_requests_account_status_created_idx
  on public.exchange_trade_requests (account_id, status, created_at desc);
create index if not exists exchange_trade_requests_account_pair_created_idx
  on public.exchange_trade_requests (account_id, pair_id, created_at desc);
create index if not exists exchange_trade_requests_contact_created_idx
  on public.exchange_trade_requests (contact_id, created_at desc)
  where contact_id is not null;
create index if not exists exchange_trade_requests_conversation_created_idx
  on public.exchange_trade_requests (conversation_id, created_at desc)
  where conversation_id is not null;
create unique index if not exists exchange_trade_requests_decision_change_uidx
  on public.exchange_trade_requests (decision_change_request_id)
  where decision_change_request_id is not null;

alter table public.exchange_trade_requests enable row level security;

drop policy if exists exchange_trade_requests_select on public.exchange_trade_requests;
create policy exchange_trade_requests_select
  on public.exchange_trade_requests for select
  using (is_account_member(account_id));

-- No direct authenticated write policies. Customer creation and admin
-- lifecycle transitions will be deterministic server-side operations.

-- ------------------------------------------------------------
-- 5) Updated-at trigger shared by mutable V2 tables
-- ------------------------------------------------------------
create or replace function public.set_fx_v2_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists account_exchange_settings_updated_at on public.account_exchange_settings;
create trigger account_exchange_settings_updated_at
  before update on public.account_exchange_settings
  for each row execute function public.set_fx_v2_updated_at();

drop trigger if exists exchange_rate_pairs_updated_at on public.exchange_rate_pairs;
create trigger exchange_rate_pairs_updated_at
  before update on public.exchange_rate_pairs
  for each row execute function public.set_fx_v2_updated_at();

drop trigger if exists exchange_trade_requests_updated_at on public.exchange_trade_requests;
create trigger exchange_trade_requests_updated_at
  before update on public.exchange_trade_requests
  for each row execute function public.set_fx_v2_updated_at();

-- ------------------------------------------------------------
-- 6) Explicit grants
-- ------------------------------------------------------------
revoke all on table public.account_exchange_settings from anon;
revoke all on table public.exchange_rate_pairs from anon;
revoke all on table public.exchange_rate_versions from anon;
revoke all on table public.exchange_trade_requests from anon;

-- Account members can read all FX state. Admin write access to settings
-- and pair metadata is still narrowed by RLS. Published rates and trade
-- lifecycle writes remain server-side only.
grant select, insert, update, delete on table public.account_exchange_settings to authenticated;
grant select, insert, update on table public.exchange_rate_pairs to authenticated;
grant select on table public.exchange_rate_versions to authenticated;
grant select on table public.exchange_trade_requests to authenticated;

grant all on table public.account_exchange_settings to service_role;
grant all on table public.exchange_rate_pairs to service_role;
grant all on table public.exchange_rate_versions to service_role;
grant all on table public.exchange_trade_requests to service_role;
grant usage, select on sequence public.exchange_trade_requests_code_seq to service_role;

-- No legacy FX table is dropped or altered here. Migration away from
-- exchange_rate_books/exchange_rate_book_versions/exchange_rates/
-- exchange_rate_history happens only after later runtime phases are
-- verified and legacy references reach zero.
