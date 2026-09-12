-- ============================================================
-- 059_coverage_marketplace_v2.sql — Coverage marketplace v2
--
-- Extends the Phase 2 coverage marketplace with the business
-- fields the Yemeni coverage desk needs:
--
--   • coverage_regions          — per-account region registry with
--                                 a macro level (north / south /
--                                 international) so offers and
--                                 requests can express "city within
--                                 macro region" and the matching
--                                 engine can score region overlap.
--   • commission columns        — commission_per_thousand (6 means
--                                 6 per 1000) + commission_currency
--                                 + commission_amount generated as
--                                 (amount * per_thousand / 1000) on
--                                 coverage_offers. Offers only: the
--                                 requester reviews offers with
--                                 their commission, they never set
--                                 one.
--   • deal_date                 — business date (defaults to
--                                 today, editable) on both tables,
--                                 separate from the immutable
--                                 created_at.
--   • GIN index on attributes   — the structured coverage
--                                 attributes (scope, regions,
--                                 methods) live in the existing
--                                 JSONB column; this index backs
--                                 the filtered marketplace reads.
--
-- Matches need no schema change: the commission in force is
-- snapshotted into fee_snapshot at booking time by the API layer.
--
-- The region table mirrors the 052 currencies pattern: per-account
-- rows, seed function + account-create trigger + backfill for
-- existing accounts. Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) coverage_regions — per-account region registry
-- ------------------------------------------------------------
create table if not exists public.coverage_regions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  -- Stable snake_case code (e.g. 'sanaa', 'aden'). Unique per
  -- account so seeds and API upserts stay deterministic.
  code          text not null
                  check (code ~ '^[a-z0-9_]{2,40}$'),
  -- Human-readable name (Arabic first class here — the desk works
  -- in Arabic).
  name          text not null,
  -- Macro region. 'north' / 'south' mirror the two Yemeni rial
  -- zones; 'international' groups abroad destinations.
  macro_region  text not null
                  check (macro_region in ('north', 'south', 'international')),
  -- ISO-3166 alpha-2 (default Yemen). Free text for flexibility.
  country       text not null default 'YE',
  -- 'active' | 'inactive'. Inactive regions stay for history.
  status        text not null default 'active'
                  check (status in ('active', 'inactive')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists coverage_regions_account_code_uidx
  on public.coverage_regions (account_id, code);

create index if not exists coverage_regions_account_macro_status_idx
  on public.coverage_regions (account_id, macro_region, status);

alter table public.coverage_regions enable row level security;

drop policy if exists coverage_regions_select on public.coverage_regions;
create policy coverage_regions_select on public.coverage_regions for select
  using (is_account_member(account_id));

drop policy if exists coverage_regions_insert on public.coverage_regions;
create policy coverage_regions_insert on public.coverage_regions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists coverage_regions_update on public.coverage_regions;
create policy coverage_regions_update on public.coverage_regions for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists coverage_regions_delete on public.coverage_regions;
create policy coverage_regions_delete on public.coverage_regions for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_coverage_regions_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists coverage_regions_updated_at on public.coverage_regions;
create trigger coverage_regions_updated_at
  before update on public.coverage_regions
  for each row execute function public.update_coverage_regions_updated_at();

-- ------------------------------------------------------------
-- 2) Seed the default Yemeni regions for every account
-- ------------------------------------------------------------
-- Same rationale as the currency seed (052): per-account rows so
-- an account can rename/disable without touching another tenant.
create or replace function public.seed_default_coverage_regions_for_account(
  p_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.coverage_regions
    (account_id, code, name, macro_region, country)
  values
    (p_account_id, 'sanaa',      'صنعاء',   'north',         'YE'),
    (p_account_id, 'saada',      'صعدة',    'north',         'YE'),
    (p_account_id, 'hajjah',     'حجة',     'north',         'YE'),
    (p_account_id, 'amran',      'عمران',   'north',         'YE'),
    (p_account_id, 'al_mahwit',  'المحويت', 'north',         'YE'),
    (p_account_id, 'dhamar',     'ذمار',    'north',         'YE'),
    (p_account_id, 'ibb',        'إب',      'north',         'YE'),
    (p_account_id, 'al_jawf',    'الجوف',   'north',         'YE'),
    (p_account_id, 'raymah',     'الريم',   'north',         'YE'),
    (p_account_id, 'marib',      'مأرب',    'north',         'YE'),
    (p_account_id, 'al_bayda',   'البيضاء', 'north',         'YE'),
    (p_account_id, 'aden',       'عدن',     'south',         'YE'),
    (p_account_id, 'taiz',       'تعز',     'south',         'YE'),
    (p_account_id, 'lahj',       'لحج',     'south',         'YE'),
    (p_account_id, 'abyan',      'أبين',    'south',         'YE'),
    (p_account_id, 'shabwah',    'شبوة',    'south',         'YE'),
    (p_account_id, 'al_mahrah',  'المهرة',  'south',         'YE'),
    (p_account_id, 'hadramawt',  'حضرموت',  'south',         'YE'),
    (p_account_id, 'socotra',    'سقطرى',   'south',         'YE'),
    (p_account_id, 'abroad',     'خارج اليمن', 'international', 'XX')
  on conflict (account_id, code) do nothing;
end;
$$;

revoke all on function public.seed_default_coverage_regions_for_account(uuid) from public;
grant execute on function public.seed_default_coverage_regions_for_account(uuid) to service_role;

create or replace function public.trg_seed_default_coverage_regions_on_account()
returns trigger as $$
begin
  perform public.seed_default_coverage_regions_for_account(new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists accounts_seed_coverage_regions on public.accounts;
create trigger accounts_seed_coverage_regions
  after insert on public.accounts
  for each row execute function public.trg_seed_default_coverage_regions_on_account();

do $$
declare
  v_account record;
begin
  for v_account in select id from public.accounts loop
    perform public.seed_default_coverage_regions_for_account(v_account.id);
  end loop;
end$$;

-- ------------------------------------------------------------
-- 3) Commission + deal_date on coverage_offers
-- ------------------------------------------------------------
-- commission_per_thousand is a RATE measured per 1000 units:
--   6  → 6,000 per 1,000,000
-- The computed amount is a GENERATED column so the equation can
-- never drift from the inputs (amount × rate ÷ 1000).
alter table public.coverage_offers
  add column if not exists commission_per_thousand numeric(12, 4);

alter table public.coverage_offers
  add column if not exists commission_currency text;

do $$
begin
  begin
    alter table public.coverage_offers
      add constraint coverage_offers_commission_rate_check
      check (commission_per_thousand is null or commission_per_thousand >= 0);
  exception when duplicate_object then
    null;
  end;
end$$;

do $$
begin
  begin
    alter table public.coverage_offers
      add constraint coverage_offers_commission_currency_check
      check (commission_currency is null or commission_currency ~ '^[A-Z_]{3,8}$');
  exception when duplicate_object then
    null;
  end;
end$$;

-- Generated: amount × per_thousand ÷ 1000. NULL rate → NULL
-- commission (no fake zeros on legacy rows).
alter table public.coverage_offers
  add column if not exists commission_amount numeric(20, 4)
  generated always as (
    case
      when commission_per_thousand is null then null
      else total_amount * commission_per_thousand / 1000.0
    end
  ) stored;

alter table public.coverage_offers
  add column if not exists deal_date date not null default current_date;

-- ------------------------------------------------------------
-- 4) deal_date on coverage_requests (no commission — the
-- requester reviews offers with their commission; they never
-- set one)
-- ------------------------------------------------------------
alter table public.coverage_requests
  add column if not exists deal_date date not null default current_date;

-- ------------------------------------------------------------
-- 5) GIN indexes for attribute filtering (scope / regions /
-- methods live in the attributes JSONB)
-- ------------------------------------------------------------
create index if not exists coverage_offers_attributes_gin
  on public.coverage_offers using gin (attributes jsonb_path_ops);

create index if not exists coverage_requests_attributes_gin
  on public.coverage_requests using gin (attributes jsonb_path_ops);

create index if not exists coverage_offers_deal_date_idx
  on public.coverage_offers (account_id, deal_date desc);

create index if not exists coverage_requests_deal_date_idx
  on public.coverage_requests (account_id, deal_date desc);
