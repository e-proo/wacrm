-- ============================================================
-- 062_coverage_rates_board.sql — commission rate board + notes
--
-- 1) coverage_offers.notes — free-text note (parity with
--    coverage_requests.notes from 050) so the desk can record
--    whatever the customer said about a specific deal.
--
-- 2) coverage_commission_cards — the account's published
--    COMMISSION RATE BOARD: three rates (cash pickup / remittance
--    / plain coverage) for each of the three markets (north,
--    south, international). Rates are measured per 1000 exactly
--    like coverage_offers.commission_per_thousand (7 = 7 per
--    1000). This board is what the customer-facing agent reads to
--    answer "كم عمولة التغطية؟" without the operator needing to
--    expose any live offer rows.
--
--    HISTORY REQUIREMENT: rows are never updated in place — every
--    save inserts a NEW card and flips the previous one out of
--    the current slot (partial unique index enforces exactly one
--    current card per account). The UI shows the current card and
--    can list past cards for audit.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) notes on coverage_offers
-- ------------------------------------------------------------
alter table public.coverage_offers
  add column if not exists notes text;

-- ------------------------------------------------------------
-- 2) coverage_commission_cards — versioned rate board
-- ------------------------------------------------------------
create table if not exists public.coverage_commission_cards (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  -- NORTH market rates (old-rial zone)
  north_cash        numeric(12, 4) check (north_cash is null or north_cash >= 0),
  north_remit       numeric(12, 4) check (north_remit is null or north_remit >= 0),
  north_coverage    numeric(12, 4) check (north_coverage is null or north_coverage >= 0),
  -- SOUTH market rates (new-rial zone)
  south_cash        numeric(12, 4) check (south_cash is null or south_cash >= 0),
  south_remit       numeric(12, 4) check (south_remit is null or south_remit >= 0),
  south_coverage    numeric(12, 4) check (south_coverage is null or south_coverage >= 0),
  -- INTERNATIONAL market rates
  intl_cash         numeric(12, 4) check (intl_cash is null or intl_cash >= 0),
  intl_remit        numeric(12, 4) check (intl_remit is null or intl_remit >= 0),
  intl_coverage     numeric(12, 4) check (intl_coverage is null or intl_coverage >= 0),
  -- Optional context for this board version (why it changed).
  notes             text,
  -- Exactly one current card per account (see partial unique index).
  is_current        boolean not null default true,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- The "current board" slot — at most one per account.
create unique index if not exists coverage_commission_cards_current_uidx
  on public.coverage_commission_cards (account_id)
  where is_current = true;

create index if not exists coverage_commission_cards_history_idx
  on public.coverage_commission_cards (account_id, created_at desc);

alter table public.coverage_commission_cards enable row level security;

drop policy if exists coverage_commission_cards_select on public.coverage_commission_cards;
create policy coverage_commission_cards_select on public.coverage_commission_cards for select
  using (is_account_member(account_id));

drop policy if exists coverage_commission_cards_insert on public.coverage_commission_cards;
create policy coverage_commission_cards_insert on public.coverage_commission_cards for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists coverage_commission_cards_update on public.coverage_commission_cards;
create policy coverage_commission_cards_update on public.coverage_commission_cards for update
  using (is_account_member(account_id, 'admin'));
