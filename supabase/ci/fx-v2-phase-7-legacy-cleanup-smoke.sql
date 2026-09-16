-- Phase 7 acceptance smoke: the legacy rate-book model must be gone while
-- the pair-centric FX V2 persistence and deterministic RPC boundary remain.

do $$
begin
  if to_regclass('public.exchange_rate_books') is not null then
    raise exception 'PHASE7_FAILED: exchange_rate_books still exists';
  end if;
  if to_regclass('public.exchange_rate_book_versions') is not null then
    raise exception 'PHASE7_FAILED: exchange_rate_book_versions still exists';
  end if;
  if to_regclass('public.exchange_rates') is not null then
    raise exception 'PHASE7_FAILED: legacy exchange_rates still exists';
  end if;
  if to_regclass('public.exchange_rate_history') is not null then
    raise exception 'PHASE7_FAILED: exchange_rate_history still exists';
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
    raise exception 'PHASE7_FAILED: legacy FX functions still exist';
  end if;

  if exists (
    select 1
    from public.change_requests
    where target_type = 'rate_book_version'
  ) then
    raise exception 'PHASE7_FAILED: legacy rate_book_version Change Requests remain';
  end if;

  if exists (
    select 1
    from public.ai_agent_tool_grants
    where tool_key = 'exchange_rates.admin_list_books'
       or (tool_key = 'exchange_rates.record_trade_request' and tool_version < 2)
       or (tool_key = 'exchange_rates.propose_pair_change' and tool_version < 2)
  ) then
    raise exception 'PHASE7_FAILED: legacy FX agent grants remain';
  end if;

  if to_regclass('public.account_exchange_settings') is null
     or to_regclass('public.exchange_rate_pairs') is null
     or to_regclass('public.exchange_rate_versions') is null
     or to_regclass('public.exchange_trade_requests') is null then
    raise exception 'PHASE7_FAILED: one or more FX V2 tables are missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'publish_exchange_rate_pair_version_v2'
  ) then
    raise exception 'PHASE7_FAILED: FX V2 publish RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_exchange_trade_request_v2'
  ) then
    raise exception 'PHASE7_FAILED: FX V2 trade creation RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'decide_exchange_trade_request_v2'
  ) then
    raise exception 'PHASE7_FAILED: FX V2 trade decision RPC is missing';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'complete_exchange_trade_request_v2'
  ) then
    raise exception 'PHASE7_FAILED: FX V2 completion RPC is missing';
  end if;
end
$$;
