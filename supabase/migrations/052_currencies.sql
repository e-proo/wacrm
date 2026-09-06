-- ============================================================
-- 052_currencies.sql — Currency catalog (Phase 2 completion)
--
-- Adds a CLOSED vocabulary for currencies so the system can:
--   • list what currencies exist (admin UI),
--   • enable/disable a currency without touching historical rows,
--   • guarantee no typo'd code slips into exchange_rate_history
--     via a future code path that opts into the new FK.
--
-- We deliberately do NOT add hard FKs to exchange_rates /
-- exchange_rate_history in this migration — those tables already
-- have `text` columns with live data. Adding a NOT NULL FK would
-- break back-compat. Phase 4 can promote the FKs once all
-- historical rows have a matching currency_code FK filled in.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) currencies
-- ------------------------------------------------------------
create table if not exists public.currencies (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id) on delete cascade,
  -- ISO-4217-like 3-letter code. UPPERCASE. Examples: SAR, USD,
  -- YER (unified Yemeni Rial after 2018 — kept here because the
  -- Yemeni market still references both old and new rials in
  -- practice; see the seed below).
  -- Underscores are allowed for historical / local codes (e.g.
  -- YER_OLD, KWD_BANK). Pattern matches the runtime validator
  -- in src/lib/services/currencies/crud.ts.
  code                  text not null
                          check (code ~ '^[A-Z_]{3,8}$'),
  -- Human-readable name shown in the UI. Stored in a separate
  -- column from `code` so the UI can localize later without
  -- breaking lookups.
  display_name          text not null,
  -- Free-text notes shown only to admins (e.g. "old Yemeni Rial,
  -- pre-2018; used in informal markets").
  notes                 text,
  -- 'active' | 'disabled'. Disabled currencies are kept for
  -- historical lookups but cannot be added to new rate rows.
  status                text not null default 'active'
                          check (status in ('active', 'disabled')),
  -- 'iso_4217' for real-world currencies, 'historical' for
  -- pre-reform codes (e.g. YER-old), 'local' for market-only
  -- variants. Drives whether the UI shows an external hint.
  kind                  text not null default 'iso_4217'
                          check (kind in ('iso_4217', 'historical', 'local')),
  -- Decimal precision used by the UI when rendering amounts in
  -- this currency. ISO-4217 defaults to 2; some markets use 3
  -- (e.g. KWD, BHD) and informal ones can be 0.
  decimal_digits        smallint not null default 2
                          check (decimal_digits between 0 and 8),
  -- The Unicode CLDR symbol used by the UI (e.g. "SAR",
  -- "US$"). Optional; admin can leave NULL.
  symbol                text,
  created_by            uuid references auth.users(id) on delete set null,
  updated_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists currencies_account_code_uidx
  on public.currencies (account_id, code);

create index if not exists currencies_account_status_idx
  on public.currencies (account_id, status);

alter table public.currencies enable row level security;

drop policy if exists currencies_select on public.currencies;
create policy currencies_select on public.currencies for select
  using (is_account_member(account_id));

drop policy if exists currencies_insert on public.currencies;
create policy currencies_insert on public.currencies for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists currencies_update on public.currencies;
create policy currencies_update on public.currencies for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists currencies_delete on public.currencies;
create policy currencies_delete on public.currencies for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_currencies_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists currencies_updated_at on public.currencies;
create trigger currencies_updated_at
  before update on public.currencies
  for each row execute function public.update_currencies_updated_at();

-- ------------------------------------------------------------
-- 2) Seed the four currencies every Yemeni account needs
--
-- The four are seeded for EVERY account on insert. The trigger
-- is account-scoped via the (account_id, code) unique index, so
-- the same `code` can exist in different accounts but never
-- twice in the same account.
--
-- Why per-account instead of a global reference table:
--   • each account manages its own currency list (some may want
--     only SAR + USD; others may add GBP, EUR, etc.),
--   • multi-tenant isolation: a freelancer account adding a
--     private "local" currency shouldn't appear in another
--     account's rate books,
--   • RLS still gates access; an owner cannot read another
--     account's currency rows even if the codes match.
--
-- Code values:
--   SAR          Saudi Riyal          ISO 4217   2 digits
--   USD          US Dollar            ISO 4217   2 digits
--   YER          Yemeni Rial (unified, post-2018)
--                                    ISO 4217   2 digits
--   YER_OLD      Yemeni Rial (pre-2018 reform)
--                                    historical 2 digits
-- ------------------------------------------------------------
create or replace function public.seed_default_currencies_for_account(
  p_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.currencies
    (account_id, code, display_name, status, kind, decimal_digits, symbol, notes)
  values
    (p_account_id, 'SAR',     'Saudi Riyal',          'active', 'iso_4217',  2, 'SAR',  null),
    (p_account_id, 'USD',     'US Dollar',            'active', 'iso_4217',  2, 'US$',  null),
    (p_account_id, 'YER',     'Yemeni Rial (current)','active', 'iso_4217',  2, 'YER',  'Unified Yemeni Rial used since 2018.'),
    (p_account_id, 'YER_OLD', 'Yemeni Rial (old)',    'active', 'historical', 2, 'YER',  'Pre-2018 Yemeni Rial still referenced in informal markets.')
  on conflict (account_id, code) do nothing;
end;
$$;

revoke all on function public.seed_default_currencies_for_account(uuid) from public;
grant execute on function public.seed_default_currencies_for_account(uuid) to service_role;

-- ------------------------------------------------------------
-- 3) Auto-seed on account creation
--
-- We hook into the existing `accounts` insert (017_account_sharing)
-- via a trigger so a brand-new account gets its four currencies
-- without anyone needing to remember to call the seed function.
-- The trigger is defined AFTER the function above so it can
-- reference it.
-- ------------------------------------------------------------
create or replace function public.trg_seed_default_currencies_on_account()
returns trigger as $$
begin
  perform public.seed_default_currencies_for_account(new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists accounts_seed_currencies on public.accounts;
create trigger accounts_seed_currencies
  after insert on public.accounts
  for each row execute function public.trg_seed_default_currencies_on_account();

-- ------------------------------------------------------------
-- 4) Backfill seed for existing accounts
--
-- Any account that existed BEFORE migration 052 doesn't have
-- currencies yet. We seed them in one pass so the admin UI
-- lights up immediately on the next deploy.
--
-- Idempotent — the ON CONFLICT DO NOTHING in the seed function
-- means we can re-run the migration safely.
-- ------------------------------------------------------------
do $$
declare
  v_account record;
begin
  for v_account in select id from public.accounts loop
    perform public.seed_default_currencies_for_account(v_account.id);
  end loop;
end$$;
