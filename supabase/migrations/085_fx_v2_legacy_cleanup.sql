-- 085_fx_v2_legacy_cleanup.sql
-- Phase 7: destructive removal of the legacy rate-book FX model.
--
-- This migration is intentionally fail-closed. It refuses to remove the old
-- schema if any legacy financial rows, rate-book Change Requests, or stale
-- legacy FX grants still exist. FX V2 objects are not modified here.

do $$
declare
  v_count bigint;
begin
  if to_regclass('public.exchange_rate_books') is not null then
    execute 'select count(*) from public.exchange_rate_books' into v_count;
    if v_count <> 0 then
      raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: exchange_rate_books contains % row(s)', v_count;
    end if;
  end if;

  if to_regclass('public.exchange_rate_book_versions') is not null then
    execute 'select count(*) from public.exchange_rate_book_versions' into v_count;
    if v_count <> 0 then
      raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: exchange_rate_book_versions contains % row(s)', v_count;
    end if;
  end if;

  if to_regclass('public.exchange_rates') is not null then
    execute 'select count(*) from public.exchange_rates' into v_count;
    if v_count <> 0 then
      raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: exchange_rates contains % row(s)', v_count;
    end if;
  end if;

  if to_regclass('public.exchange_rate_history') is not null then
    execute 'select count(*) from public.exchange_rate_history' into v_count;
    if v_count <> 0 then
      raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: exchange_rate_history contains % row(s)', v_count;
    end if;
  end if;

  if exists (
    select 1
    from public.change_requests
    where target_type = 'rate_book_version'
  ) then
    raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: rate_book_version Change Requests still exist';
  end if;

  if exists (
    select 1
    from public.ai_agent_tool_grants
    where tool_key = 'exchange_rates.admin_list_books'
       or (tool_key = 'exchange_rates.record_trade_request' and tool_version < 2)
       or (tool_key = 'exchange_rates.propose_pair_change' and tool_version < 2)
  ) then
    raise exception 'FX_V2_LEGACY_CLEANUP_BLOCKED: legacy FX agent grants still exist';
  end if;
end
$$;

-- Remove legacy trigger/function entry points before dropping their tables.
do $$
begin
  if to_regclass('public.exchange_rate_books') is not null then
    execute 'drop trigger if exists exchange_rate_books_updated_at on public.exchange_rate_books';
  end if;
end
$$;

drop function if exists public.apply_exchange_rate_pair_change(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, uuid
);
drop function if exists public.publish_exchange_rate_version(uuid, uuid, uuid);
drop function if exists public.validate_exchange_rate_version(uuid, uuid, uuid);
drop function if exists public.update_exchange_rate_books_updated_at();

-- The legacy books table holds a current-version FK back to the versions table,
-- while each version also belongs to a book. Break that cycle explicitly so the
-- tables can be dropped without CASCADE and unexpected external dependencies
-- remain visible as migration failures.
alter table if exists public.exchange_rate_books
  drop constraint if exists exchange_rate_books_current_version_fk;

drop table if exists public.exchange_rate_history;
drop table if exists public.exchange_rates;
drop table if exists public.exchange_rate_book_versions;
drop table if exists public.exchange_rate_books;

-- Postcondition: legacy persistence and callable entry points must be gone.
do $$
begin
  if to_regclass('public.exchange_rate_books') is not null
     or to_regclass('public.exchange_rate_book_versions') is not null
     or to_regclass('public.exchange_rates') is not null
     or to_regclass('public.exchange_rate_history') is not null then
    raise exception 'FX_V2_LEGACY_CLEANUP_FAILED: legacy tables remain';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'apply_exchange_rate_pair_change',
        'publish_exchange_rate_version',
        'validate_exchange_rate_version',
        'update_exchange_rate_books_updated_at'
      )
  ) then
    raise exception 'FX_V2_LEGACY_CLEANUP_FAILED: legacy functions remain';
  end if;
end
$$;
