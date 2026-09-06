-- ============================================================
-- 049_exchange_rates.sql — Exchange rate books (Phase 2 §8)
--
-- Three-table design with an atomic publish RPC:
--
--   exchange_rate_books          — context (region/channel/method)
--                                   + pointer to the live version
--   exchange_rate_book_versions  — immutable snapshot of every
--                                   rate in the book at publish time
--   exchange_rates               — one row per currency pair inside
--                                   a version, with explicit buy/sell
--
-- Atomic publish (`publish_exchange_rate_version`) supersedes the
-- previous version and swaps the book's `current_published_version_id`
-- in a single transaction — customers never see a half-published
-- rate sheet.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) exchange_rate_books
-- ------------------------------------------------------------
create table if not exists public.exchange_rate_books (
  id                            uuid primary key default gen_random_uuid(),
  account_id                    uuid not null references accounts(id) on delete cascade,
  name                          text not null,
  -- Free-form region label (e.g. "Sanaa"). Phase 2 keeps it as
  -- text; the vocabulary table (Phase 2 §17) is the source of
  -- truth once the user picks a region.
  region                        text,
  channel                       text not null default 'whatsapp'
                                  check (channel in ('whatsapp')),
  settlement_method             text
                                  check (settlement_method is null or settlement_method in (
                                    'cash', 'bank', 'wallet', 'other'
                                  )),
  timezone                      text not null default 'UTC',
  -- A published version is considered stale this many seconds
  -- after `effective_at` (or `published_at` when `effective_at`
  -- is null). 0 = never goes stale automatically; the UI surfaces
  -- an explicit "still current?" badge.
  stale_after_seconds           integer not null default 1800
                                  check (stale_after_seconds >= 0),
  current_published_version_id  uuid,
  -- 'active' | 'archived'.
  status                        text not null default 'active'
                                  check (status in ('active', 'archived')),
  created_by                    uuid references auth.users(id) on delete set null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

-- A book is uniquely keyed by (account, region, channel, settlement)
-- when active. Archived books lose the constraint so historical
-- rows can coexist with a later re-opened book.
create unique index if not exists exchange_rate_books_active_uidx
  on public.exchange_rate_books (account_id, region, channel, settlement_method)
  where status = 'active';

create index if not exists exchange_rate_books_account_idx
  on public.exchange_rate_books (account_id);

alter table public.exchange_rate_books enable row level security;

drop policy if exists exchange_rate_books_select on public.exchange_rate_books;
create policy exchange_rate_books_select on public.exchange_rate_books for select
  using (is_account_member(account_id));

drop policy if exists exchange_rate_books_insert on public.exchange_rate_books;
create policy exchange_rate_books_insert on public.exchange_rate_books for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rate_books_update on public.exchange_rate_books;
create policy exchange_rate_books_update on public.exchange_rate_books for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rate_books_delete on public.exchange_rate_books;
create policy exchange_rate_books_delete on public.exchange_rate_books for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_exchange_rate_books_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists exchange_rate_books_updated_at on public.exchange_rate_books;
create trigger exchange_rate_books_updated_at
  before update on public.exchange_rate_books
  for each row execute function public.update_exchange_rate_books_updated_at();

-- ------------------------------------------------------------
-- 2) exchange_rate_book_versions
-- ------------------------------------------------------------
create table if not exists public.exchange_rate_book_versions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  book_id       uuid not null references public.exchange_rate_books(id) on delete cascade,
  version_number integer not null,
  -- 'draft' | 'published' | 'superseded'.
  status        text not null default 'draft'
                  check (status in ('draft', 'published', 'superseded')),
  effective_at  timestamptz,
  expires_at    timestamptz,
  -- 'manual' | 'admin_agent' | 'external'. Phase 2 keeps only
  -- 'manual'; the other two are reserved for Phase 3.
  source        text not null default 'manual'
                  check (source in ('manual', 'admin_agent', 'external')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  published_by  uuid references auth.users(id) on delete set null,
  published_at  timestamptz
);

create unique index if not exists exchange_rate_book_versions_book_number_uidx
  on public.exchange_rate_book_versions (book_id, version_number);

create index if not exists exchange_rate_book_versions_account_status_idx
  on public.exchange_rate_book_versions (account_id, status);

alter table public.exchange_rate_book_versions enable row level security;

drop policy if exists exchange_rate_book_versions_select
  on public.exchange_rate_book_versions;
create policy exchange_rate_book_versions_select
  on public.exchange_rate_book_versions for select
  using (is_account_member(account_id));

drop policy if exists exchange_rate_book_versions_insert
  on public.exchange_rate_book_versions;
create policy exchange_rate_book_versions_insert
  on public.exchange_rate_book_versions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rate_book_versions_update
  on public.exchange_rate_book_versions;
create policy exchange_rate_book_versions_update
  on public.exchange_rate_book_versions for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose — versions are immutable history.

-- Attach the FK from exchange_rate_books now that the target
-- table exists.
do $$
begin
  begin
    alter table public.exchange_rate_books
      drop constraint exchange_rate_books_current_version_fk;
  exception when undefined_object then
    null;
  end;
end$$;
alter table public.exchange_rate_books
  add constraint exchange_rate_books_current_version_fk
  foreign key (current_published_version_id)
  references public.exchange_rate_book_versions(id)
  on delete set null
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 3) exchange_rates
-- ------------------------------------------------------------
create table if not exists public.exchange_rates (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  version_id        uuid not null references public.exchange_rate_book_versions(id) on delete cascade,
  base_currency     text not null,
  quote_currency    text not null,
  -- Both rates are stored as numeric(20, 8) — enough precision for
  -- the SAR/YER range the project serves.
  buy_rate          numeric(20, 8) not null check (buy_rate > 0),
  sell_rate         numeric(20, 8) not null check (sell_rate > 0),
  min_amount        numeric(20, 4),
  max_amount        numeric(20, 4),
  -- A "rate unit" override for local markets that quote per
  -- (e.g.) 100 units rather than 1. NULL = the rate is per 1 unit.
  rate_unit         numeric(20, 4),
  notes_public      text,
  notes_internal    text,
  created_at        timestamptz not null default now()
);

-- Within a version, each (base, quote, min, max) combination can
-- appear at most once. NULL min/max are coalesced to a sentinel so
-- Postgres treats "no min" + "no max" as a single bucket rather
-- than a unique-violation source.
create unique index if not exists exchange_rates_version_pair_uidx
  on public.exchange_rates (
    version_id, base_currency, quote_currency,
    coalesce(min_amount, -1), coalesce(max_amount, -1)
  );

create index if not exists exchange_rates_account_idx
  on public.exchange_rates (account_id);

alter table public.exchange_rates enable row level security;

drop policy if exists exchange_rates_select on public.exchange_rates;
create policy exchange_rates_select on public.exchange_rates for select
  using (is_account_member(account_id));

drop policy if exists exchange_rates_insert on public.exchange_rates;
create policy exchange_rates_insert on public.exchange_rates for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rates_update on public.exchange_rates;
create policy exchange_rates_update on public.exchange_rates for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists exchange_rates_delete on public.exchange_rates;
create policy exchange_rates_delete on public.exchange_rates for delete
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4) Atomic publish RPC
-- ------------------------------------------------------------
-- Validates the draft version in one go:
--   • no duplicate (base, quote) pairs,
--   • every row has buy > 0 and sell > 0,
--   • no overlapping min/max windows per pair.
-- Then supersedes the previous published version and swaps the
-- book's `current_published_version_id` atomically.
create or replace function public.publish_exchange_rate_version(
  p_book_id      uuid,
  p_version_id   uuid,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_book_status text;
  v_version_status text;
  v_new_status text := 'published';
  v_existing uuid;
  v_published_id uuid;
begin
  -- Locate the book (account-scoped via the version row).
  select v.account_id, b.status, v.status
    into v_account_id, v_book_status, v_version_status
    from public.exchange_rate_book_versions v
    join public.exchange_rate_books b on b.id = v.book_id
   where v.id = p_version_id
     and v.book_id = p_book_id;

  if v_account_id is null then
    raise exception 'EXCHANGE_BOOK_OR_VERSION_NOT_FOUND'
      using errcode = 'P0001';
  end if;
  if v_book_status <> 'active' then
    raise exception 'EXCHANGE_BOOK_NOT_ACTIVE'
      using errcode = 'P0001';
  end if;
  if v_version_status <> 'draft' then
    raise exception 'EXCHANGE_VERSION_NOT_DRAFT'
      using errcode = 'P0001';
  end if;

  -- Reject duplicate currency pairs (defensive; the unique index
  -- also enforces it but we want a typed error).
  if exists (
    select 1
      from public.exchange_rates
     where version_id = p_version_id
     group by base_currency, quote_currency
    having count(*) > 1
  ) then
    raise exception 'EXCHANGE_DUPLICATE_PAIR'
      using errcode = 'P0001';
  end if;

  -- Supersede the previously published version (if any).
  select current_published_version_id into v_existing
    from public.exchange_rate_books
   where id = p_book_id;
  if v_existing is not null and v_existing <> p_version_id then
    update public.exchange_rate_book_versions
       set status = 'superseded'
     where id = v_existing
       and status = 'published';
  end if;

  -- Publish the target version.
  update public.exchange_rate_book_versions
     set status = v_new_status,
         published_at = now(),
         published_by = p_actor_user_id
   where id = p_version_id
     and status = 'draft'
  returning id into v_published_id;

  if v_published_id is null then
    raise exception 'EXCHANGE_PUBLISH_CONFLICT'
      using errcode = 'P0001';
  end if;

  -- Swap the live pointer on the book.
  update public.exchange_rate_books
     set current_published_version_id = v_published_id
   where id = p_book_id;

  -- Audit.
  perform public.append_service_activity_event(
    v_account_id,
    'rate_book_version',
    v_published_id,
    'exchange_rate.version.published',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('book_id', p_book_id, 'version_id', v_published_id)
  );

  return v_published_id;
end;
$$;

revoke all on function public.publish_exchange_rate_version(
  uuid, uuid, uuid
) from public;
grant execute on function public.publish_exchange_rate_version(
  uuid, uuid, uuid
) to service_role;
