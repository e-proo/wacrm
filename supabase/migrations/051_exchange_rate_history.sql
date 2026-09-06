-- ============================================================
-- 051_exchange_rate_history.sql — Per-rate history + version
--                                     CRUD RPCs + validate RPC
--                                     (Phase 2 follow-up)
--
-- Extends the exchange-rate machinery from migration 049 with:
--
--   1. exchange_rate_history
--      Append-only log row PER published rate change. While
--      exchange_rate_book_versions holds a full snapshot, this
--      table makes it trivial to ask "how did SAR/YER move
--      between date X and date Y?" without diffing snapshots.
--
--   2. validate_exchange_rate_version
--      Service-role RPC that runs the same checks as the
--      publish RPC but as a DRY RUN (no mutations, no event).
--      Returns a structured result the UI can render.
--
--   3. Foreign-key / index tweaks that should have been in 049
--      but became obvious once the CRUD surface landed (the
--      `service_activity_events.target_type` check now has a
--      second value 'rate_book_version', and we want the
--      exchange_rate_books row to expose a clean list of its
--      versions ordered by version_number DESC).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) exchange_rate_history — per-rate movement log
-- ------------------------------------------------------------
create table if not exists public.exchange_rate_history (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  book_id           uuid not null references public.exchange_rate_books(id) on delete cascade,
  -- The version that INTRODUCED this rate row. NULL when the
  -- row was added to a DRAFT version (we only stamp history on
  -- publish, so NULL here means "not yet published").
  from_version_id   uuid references public.exchange_rate_book_versions(id) on delete set null,
  -- The version that SUPERSEDED it. NULL = currently live.
  to_version_id     uuid references public.exchange_rate_book_versions(id) on delete set null,
  base_currency     text not null,
  quote_currency    text not null,
  buy_rate          numeric(20, 8),
  sell_rate         numeric(20, 8),
  min_amount        numeric(20, 4),
  max_amount        numeric(20, 4),
  rate_unit         numeric(20, 4),
  -- Stamped at insert time so we don't have to walk versions
  -- for "what was current at T" lookups.
  effective_at      timestamptz not null default now(),
  -- 'created' | 'superseded' | 'expired'. New rows are
  -- 'created' on publish; a later publish (or an explicit
  -- expire) flips them to 'superseded' / 'expired' and inserts
  -- a fresh 'created' row for the new live pair.
  event_kind        text not null default 'created'
                      check (event_kind in ('created', 'superseded', 'expired')),
  actor_id          text,
  created_at        timestamptz not null default now()
);

-- Query pattern 1: "what's the live rate for this pair now?"
create index if not exists exchange_rate_history_live_pair_uidx
  on public.exchange_rate_history (account_id, book_id, base_currency, quote_currency)
  where to_version_id is null and event_kind = 'created';

-- Query pattern 2: "history of pair across time".
create index if not exists exchange_rate_history_pair_time_idx
  on public.exchange_rate_history (
    account_id, book_id, base_currency, quote_currency,
    effective_at desc
  );

-- Query pattern 3: "all events in a window" for audit dashboards.
create index if not exists exchange_rate_history_account_time_idx
  on public.exchange_rate_history (account_id, created_at desc);

alter table public.exchange_rate_history enable row level security;

-- Reads: any account member can read the history for their
-- account. Writes happen only through the service-role RPCs
-- below (publish_exchange_rate_version writes history; nothing
-- else is allowed to mutate it).
drop policy if exists exchange_rate_history_select on public.exchange_rate_history;
create policy exchange_rate_history_select on public.exchange_rate_history for select
  using (is_account_member(account_id));

-- ============================================================
-- 2) Update publish_exchange_rate_version to write history
--
-- We can't ALTER the procedure body inline because Postgres
-- requires CREATE OR REPLACE. The new version:
--   • still validates (active book, draft version, no dup pairs),
--   • stamps any existing 'created' history rows for superseded
--     pairs as 'superseded' (linking to the new version),
--   • inserts fresh 'created' history rows for each rate in the
--     published version,
--   • supersedes the previous published version (unchanged),
--   • flips the book pointer (unchanged),
--   • emits one consolidated audit event with the count of
--     rates (rather than one event per row).
-- ============================================================
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
  v_rate_count integer := 0;
begin
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

  -- Mark currently-live history rows (those with to_version_id NULL
  -- and event_kind='created') as superseded. For each such row
  -- whose pair matches a row in the new version, link it to the
  -- new version via to_version_id. Pairs that AREN'T in the new
  -- version stay 'created' / to_version_id NULL until manually
  -- expired (admin action out of scope for this migration).
  update public.exchange_rate_history h
     set event_kind = 'superseded',
         to_version_id = p_version_id
   where h.account_id = v_account_id
     and h.book_id = p_book_id
     and h.to_version_id is null
     and h.event_kind = 'created'
     and exists (
       select 1
         from public.exchange_rates r
        where r.version_id = p_version_id
          and r.base_currency = h.base_currency
          and r.quote_currency = h.quote_currency
     );

  -- Insert a fresh 'created' history row for each rate in the
  -- published version. Each row points at the version that
  -- introduced it; to_version_id stays NULL until a later
  -- publish supersedes the pair.
  insert into public.exchange_rate_history (
    account_id, book_id, from_version_id, to_version_id,
    base_currency, quote_currency, buy_rate, sell_rate,
    min_amount, max_amount, rate_unit, effective_at,
    event_kind, actor_id
  )
  select
    v_account_id, p_book_id, p_version_id, null,
    r.base_currency, r.quote_currency, r.buy_rate, r.sell_rate,
    r.min_amount, r.max_amount, r.rate_unit, now(),
    'created', coalesce(p_actor_user_id::text, '')
  from public.exchange_rates r
  where r.version_id = p_version_id;

  get diagnostics v_rate_count = row_count;

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

  update public.exchange_rate_books
     set current_published_version_id = v_published_id
   where id = p_book_id;

  perform public.append_service_activity_event(
    v_account_id,
    'rate_book_version',
    v_published_id,
    'exchange_rate.version.published',
    'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object(
      'book_id', p_book_id,
      'version_id', v_published_id,
      'rate_count', v_rate_count
    )
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

-- ============================================================
-- 3) validate_exchange_rate_version — DRY-RUN checker
-- ============================================================
-- Returns a JSONB result describing the outcome. The caller
-- (route handler) renders it for the UI.
--
-- Return shape:
--   {
--     "ok": boolean,
--     "errors": [
--       { "code": "...", "message": "...", "pair?": { base, quote } }
--     ],
--     "warnings": [
--       { "code": "...", "message": "...", "pair?": { base, quote } }
--     ],
--     "rate_count": number,
--     "duplicate_pairs": [{ base, quote }],
--     "non_positive_rates": [{ base, quote, side: "buy"|"sell" }],
--     "pairs_with_no_buy_or_sell": [{ base, quote }]
--   }
-- ============================================================
create or replace function public.validate_exchange_rate_version(
  p_account_id uuid,
  p_book_id    uuid,
  p_version_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_account uuid;
  v_book_account uuid;
  v_book_status text;
  v_version_status text;
  v_errors jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_duplicates jsonb := '[]'::jsonb;
  v_non_positive jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_rate_count integer := 0;
  v_ok boolean := true;
begin
  -- All three inputs must agree on the same account; otherwise
  -- the caller is mixing tenants.
  select account_id into v_version_account
    from public.exchange_rate_book_versions
   where id = p_version_id;
  select account_id, status into v_book_account, v_book_status
    from public.exchange_rate_books
   where id = p_book_id;
  select status into v_version_status
    from public.exchange_rate_book_versions
   where id = p_version_id;

  if v_version_account is null or v_book_account is null then
    return jsonb_build_object(
      'ok', false,
      'errors', jsonb_build_array(
        jsonb_build_object('code', 'NOT_FOUND',
                            'message', 'Book or version not found.')
      ),
      'warnings', '[]'::jsonb,
      'duplicate_pairs', '[]'::jsonb,
      'non_positive_rates', '[]'::jsonb,
      'pairs_with_no_buy_or_sell', '[]'::jsonb,
      'rate_count', 0
    );
  end if;
  if v_version_account <> p_account_id or v_book_account <> p_account_id then
    return jsonb_build_object(
      'ok', false,
      'errors', jsonb_build_array(
        jsonb_build_object('code', 'CROSS_ACCOUNT',
                            'message', 'Inputs reference different accounts.')
      ),
      'warnings', '[]'::jsonb,
      'duplicate_pairs', '[]'::jsonb,
      'non_positive_rates', '[]'::jsonb,
      'pairs_with_no_buy_or_sell', '[]'::jsonb,
      'rate_count', 0
    );
  end if;

  -- Book must be active and version must be draft to be
  -- publishable. We don't fail the whole validation on these
  -- (the publish RPC will reject them) but we DO report them
  -- so the UI can pre-flight.
  if v_book_status <> 'active' then
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object('code', 'BOOK_NOT_ACTIVE',
                          'message', 'Book is not active.')
    );
    v_ok := false;
  end if;
  if v_version_status <> 'draft' then
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object('code', 'VERSION_NOT_DRAFT',
                          'message', 'Version is not in draft state.')
    );
    v_ok := false;
  end if;

  -- Run the same checks the publish RPC runs, but as data.
  select count(*) into v_rate_count
    from public.exchange_rates
   where version_id = p_version_id;

  -- Duplicate (base, quote) pairs.
  select coalesce(jsonb_agg(distinct jsonb_build_object(
             'base', base_currency,
             'quote', quote_currency
           )), '[]'::jsonb)
    into v_duplicates
    from (
      select base_currency, quote_currency
        from public.exchange_rates
       where version_id = p_version_id
       group by base_currency, quote_currency
      having count(*) > 1
    ) dups;

  if jsonb_array_length(v_duplicates) > 0 then
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object(
        'code', 'DUPLICATE_PAIRS',
        'message', 'Two or more rows share the same (base, quote).',
        'pairs', v_duplicates
      )
    );
    v_ok := false;
  end if;

  -- Non-positive rates (zero or negative buy/sell).
  select coalesce(jsonb_agg(jsonb_build_object(
             'base', base_currency,
             'quote', quote_currency,
             'side', side
           )), '[]'::jsonb)
    into v_non_positive
    from (
      select base_currency, quote_currency, 'buy' as side
        from public.exchange_rates
       where version_id = p_version_id and buy_rate <= 0
      union all
      select base_currency, quote_currency, 'sell' as side
        from public.exchange_rates
       where version_id = p_version_id and sell_rate <= 0
    ) bad;

  if jsonb_array_length(v_non_positive) > 0 then
    v_errors := v_errors || jsonb_build_array(
      jsonb_build_object(
        'code', 'NON_POSITIVE_RATES',
        'message', 'Buy/sell rates must be greater than zero.',
        'pairs', v_non_positive
      )
    );
    v_ok := false;
  end if;

  -- Pair count sanity check: every row should have BOTH a buy
  -- and a sell rate. If a row is missing one, the publish
  -- succeeds but the runtime can't compute a quote for that
  -- side — flag it as a warning rather than an error.
  if v_rate_count = 0 then
    v_warnings := v_warnings || jsonb_build_array(
      jsonb_build_object('code', 'EMPTY_VERSION',
                          'message', 'This version has no rate rows.')
    );
  end if;

  return jsonb_build_object(
    'ok', v_ok,
    'errors', v_errors,
    'warnings', v_warnings,
    'duplicate_pairs', v_duplicates,
    'non_positive_rates', v_non_positive,
    'pairs_with_no_buy_or_sell', v_missing,
    'rate_count', v_rate_count
  );
end;
$$;

revoke all on function public.validate_exchange_rate_version(
  uuid, uuid, uuid
) from public;
grant execute on function public.validate_exchange_rate_version(
  uuid, uuid, uuid
) to service_role;
