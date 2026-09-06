-- ============================================================
-- 053_currency_integration.sql — Tie currencies into rate tables
--                                  (Phase 2 completion)
--
-- The migration 052 added the catalog but kept exchange_rates /
-- exchange_rate_history on free-text columns to avoid breaking
-- existing data. This migration ADDS nullable FK columns so
-- new rows can OPT IN to a closed vocabulary; existing rows
-- stay valid as `code` text.
--
-- The plan is to backfill the FKs from `code` when possible, and
-- eventually tighten the constraints in a later migration. For
-- now the runtime uses the new FK when set and falls back to the
-- text column otherwise.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) exchange_rates.currency_id_base / currency_id_quote
--
-- Two columns because the existing `base_currency` / `quote_currency`
-- text columns stay valid for historical rows. New code paths
-- should set the FK columns AND mirror them to the text columns
-- so legacy readers continue to work.
-- ------------------------------------------------------------
alter table public.exchange_rates
  add column if not exists currency_id_base uuid
    references public.currencies(id) on delete restrict,
  add column if not exists currency_id_quote uuid
    references public.currencies(id) on delete restrict;

create index if not exists exchange_rates_currency_base_idx
  on public.exchange_rates (account_id, currency_id_base);
create index if not exists exchange_rates_currency_quote_idx
  on public.exchange_rates (account_id, currency_id_quote);

-- ------------------------------------------------------------
-- 2) exchange_rate_history.currency_id_base / currency_id_quote
--
-- Same pattern. History rows written BEFORE this migration have
-- text-only; new history rows (written by publish_exchange_rate_version)
-- should mirror the FK columns.
-- ------------------------------------------------------------
alter table public.exchange_rate_history
  add column if not exists currency_id_base uuid
    references public.currencies(id) on delete restrict,
  add column if not exists currency_id_quote uuid
    references public.currencies(id) on delete restrict;

create index if not exists exchange_rate_history_currency_base_idx
  on public.exchange_rate_history (account_id, currency_id_base);
create index if not exists exchange_rate_history_currency_quote_idx
  on public.exchange_rate_history (account_id, currency_id_quote);

-- ------------------------------------------------------------
-- 3) Backfill the FKs from the text columns when an exact
-- (account_id, code) match exists.
--
-- Done in plpgsql so it runs once per migration. The CASE makes
-- it idempotent — re-running finds no unmatched rows.
-- ------------------------------------------------------------
do $$
declare
  v_rates_updated integer := 0;
  v_history_updated integer := 0;
  v_rows integer;
begin
  update public.exchange_rates r
     set currency_id_base = c.id
    from public.currencies c
   where c.account_id = r.account_id
     and c.code = r.base_currency
     and r.currency_id_base is null;
  get diagnostics v_rows = row_count;
  v_rates_updated := v_rates_updated + v_rows;

  update public.exchange_rates r
     set currency_id_quote = c.id
    from public.currencies c
   where c.account_id = r.account_id
     and c.code = r.quote_currency
     and r.currency_id_quote is null;
  get diagnostics v_rows = row_count;
  v_rates_updated := v_rates_updated + v_rows;

  update public.exchange_rate_history h
     set currency_id_base = c.id
    from public.currencies c
   where c.account_id = h.account_id
     and c.code = h.base_currency
     and h.currency_id_base is null;
  get diagnostics v_rows = row_count;
  v_history_updated := v_history_updated + v_rows;

  update public.exchange_rate_history h
     set currency_id_quote = c.id
    from public.currencies c
   where c.account_id = h.account_id
     and c.code = h.quote_currency
     and h.currency_id_quote is null;
  get diagnostics v_rows = row_count;
  v_history_updated := v_history_updated + v_rows;

  raise notice 'Backfilled % exchange_rates rows + % history rows',
    v_rates_updated, v_history_updated;
end$$;

-- ------------------------------------------------------------
-- 4) Update publish_exchange_rate_version to mirror the FK
-- into the new columns so newly published rows are integrated.
--
-- We REPLACE the function body; this is the same procedure
-- declared in 051_exchange_rate_history.sql. Re-declaring here
-- keeps the migration self-contained for review.
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

  -- Mirror text codes into the new FK columns on the version
  -- being published. We do this BEFORE the history insert so
  -- the history rows can carry the FK too.
  update public.exchange_rates r
     set currency_id_base = c.id
    from public.currencies c
   where r.version_id = p_version_id
     and c.account_id = r.account_id
     and c.code = r.base_currency
     and r.currency_id_base is null;
  update public.exchange_rates r
     set currency_id_quote = c.id
    from public.currencies c
   where r.version_id = p_version_id
     and c.account_id = r.account_id
     and c.code = r.quote_currency
     and r.currency_id_quote is null;

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

  insert into public.exchange_rate_history (
    account_id, book_id, from_version_id, to_version_id,
    base_currency, quote_currency,
    currency_id_base, currency_id_quote,
    buy_rate, sell_rate,
    min_amount, max_amount, rate_unit, effective_at,
    event_kind, actor_id
  )
  select
    v_account_id, p_book_id, p_version_id, null,
    r.base_currency, r.quote_currency,
    r.currency_id_base, r.currency_id_quote,
    r.buy_rate, r.sell_rate,
    r.min_amount, r.max_amount, r.rate_unit, now(),
    'created', coalesce(p_actor_user_id::text, '')
  from public.exchange_rates r
  where r.version_id = p_version_id;

  get diagnostics v_rate_count = row_count;

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
     set status = 'published',
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
