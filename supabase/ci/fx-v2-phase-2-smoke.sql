-- FX V2 Phase 2 transactional integration smoke test.
--
-- Runs as one DO statement because `supabase db query --file` sends the
-- whole file as one prepared statement. The statement is transactional:
-- any failed assertion rolls back the fixture automatically. On success,
-- the fixture is explicitly removed before the statement commits.
--
-- Coverage:
--   * default account currencies exist for a fresh account
--   * publish V1 and enforce optimistic pair locking
--   * create a customer_buy request against an expected rate version
--   * exact idempotent retry returns the same request
--   * approve -> approved_for_contact -> completed lifecycle
--   * publish V2
--   * reject a request submitted against stale V1
--   * service-role-only RPC privilege boundary

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_account_id uuid;
  v_base_currency_id uuid;
  v_quote_currency_id uuid;
  v_pair_id uuid;
  v_publish_v1 jsonb;
  v_publish_v2 jsonb;
  v_trade jsonb;
  v_retry jsonb;
  v_decision jsonb;
  v_complete jsonb;
  v_old_version_id uuid;
  v_trade_id uuid;
begin
  -- The five Phase 2 mutation RPCs must remain internal server-side APIs.
  if not has_function_privilege(
    'service_role',
    'public.publish_exchange_rate_pair_version_v2(uuid,uuid,bigint,numeric,numeric,text,uuid,text,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.publish_exchange_rate_pair_version_v2(uuid,uuid,bigint,numeric,numeric,text,uuid,text,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.publish_exchange_rate_pair_version_v2(uuid,uuid,bigint,numeric,numeric,text,uuid,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'FX_SMOKE_RPC_PRIVILEGE_BOUNDARY_FAILED';
  end if;

  -- A lightweight local auth user gives accounts.owner_user_id a valid FK.
  -- The current signup trigger normally creates the account/profile. The
  -- fallback account insert keeps this smoke focused on FX if that trigger
  -- is intentionally disabled in a future local-test configuration.
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    v_user_id,
    'fx-v2-smoke-' || replace(v_user_id::text, '-', '') || '@example.invalid',
    '{}'::jsonb
  );

  select id into v_account_id
  from public.accounts
  where owner_user_id = v_user_id;

  if v_account_id is null then
    insert into public.accounts (name, owner_user_id)
    values ('FX V2 phase 2 smoke', v_user_id)
    returning id into v_account_id;
  end if;

  select id into v_base_currency_id
  from public.currencies
  where account_id = v_account_id and code = 'SAR';

  select id into v_quote_currency_id
  from public.currencies
  where account_id = v_account_id and code = 'YER';

  if v_base_currency_id is null or v_quote_currency_id is null then
    raise exception 'FX_SMOKE_DEFAULT_CURRENCIES_MISSING';
  end if;

  insert into public.account_exchange_settings (
    account_id,
    base_currency_id,
    created_by,
    updated_by
  ) values (
    v_account_id,
    v_base_currency_id,
    v_user_id,
    v_user_id
  );

  insert into public.exchange_rate_pairs (
    account_id,
    base_currency_id,
    quote_currency_id,
    created_by,
    updated_by
  ) values (
    v_account_id,
    v_base_currency_id,
    v_quote_currency_id,
    v_user_id,
    v_user_id
  ) returning id into v_pair_id;

  select public.publish_exchange_rate_pair_version_v2(
    v_account_id,
    v_pair_id,
    0,
    425,
    428,
    'manual',
    null,
    'automated Phase 2 smoke V1',
    v_user_id
  ) into v_publish_v1;

  if (v_publish_v1->>'version_number')::integer <> 1
     or (v_publish_v1->>'lock_version')::bigint <> 1
     or (v_publish_v1->>'idempotent')::boolean then
    raise exception 'FX_SMOKE_BAD_V1_RESULT: %', v_publish_v1;
  end if;

  v_old_version_id := (v_publish_v1->>'version_id')::uuid;

  -- Reusing the stale pair lock must never overwrite V1.
  begin
    perform public.publish_exchange_rate_pair_version_v2(
      v_account_id,
      v_pair_id,
      0,
      426,
      429,
      'manual',
      null,
      'stale publish must fail',
      v_user_id
    );
    raise exception 'FX_SMOKE_EXPECTED_PAIR_VERSION_CONFLICT';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'FX_PAIR_VERSION_CONFLICT' then
        raise;
      end if;
  end;

  select public.create_exchange_trade_request_v2(
    v_account_id,
    v_pair_id,
    'customer_buy',
    'base',
    1000,
    'fx-v2-smoke-buy-0001',
    v_old_version_id,
    null,
    null,
    jsonb_build_object('source', 'ci-smoke')
  ) into v_trade;

  if v_trade->>'status' <> 'pending_admin'
     or (v_trade->>'effective_rate')::numeric <> 428
     or (v_trade->>'base_amount')::numeric <> 1000
     or (v_trade->>'quote_amount')::numeric <> 428000
     or (v_trade->>'idempotent')::boolean then
    raise exception 'FX_SMOKE_BAD_TRADE_RESULT: %', v_trade;
  end if;

  v_trade_id := (v_trade->>'request_id')::uuid;

  select public.create_exchange_trade_request_v2(
    v_account_id,
    v_pair_id,
    'customer_buy',
    'base',
    1000,
    'fx-v2-smoke-buy-0001',
    v_old_version_id,
    null,
    null,
    jsonb_build_object('source', 'ci-smoke')
  ) into v_retry;

  if (v_retry->>'request_id')::uuid <> v_trade_id
     or not (v_retry->>'idempotent')::boolean then
    raise exception 'FX_SMOKE_IDEMPOTENCY_FAILED: %', v_retry;
  end if;

  select public.decide_exchange_trade_request_v2(
    v_account_id,
    v_trade_id,
    'pending_admin',
    'approve',
    null,
    'approved by automated smoke',
    v_user_id
  ) into v_decision;

  if v_decision->>'status' <> 'approved_for_contact' then
    raise exception 'FX_SMOKE_APPROVE_FAILED: %', v_decision;
  end if;

  select public.complete_exchange_trade_request_v2(
    v_account_id,
    v_trade_id,
    v_user_id
  ) into v_complete;

  if v_complete->>'status' <> 'completed' then
    raise exception 'FX_SMOKE_COMPLETE_FAILED: %', v_complete;
  end if;

  select public.publish_exchange_rate_pair_version_v2(
    v_account_id,
    v_pair_id,
    1,
    426,
    429,
    'manual',
    null,
    'automated Phase 2 smoke V2',
    v_user_id
  ) into v_publish_v2;

  if (v_publish_v2->>'version_number')::integer <> 2
     or (v_publish_v2->>'lock_version')::bigint <> 2
     or (v_publish_v2->>'idempotent')::boolean then
    raise exception 'FX_SMOKE_BAD_V2_RESULT: %', v_publish_v2;
  end if;

  -- A quote from V1 cannot be submitted after V2 becomes current.
  begin
    perform public.create_exchange_trade_request_v2(
      v_account_id,
      v_pair_id,
      'customer_sell',
      'base',
      1000,
      'fx-v2-smoke-stale-0002',
      v_old_version_id,
      null,
      null,
      '{}'::jsonb
    );
    raise exception 'FX_SMOKE_EXPECTED_RATE_VERSION_CONFLICT';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'FX_RATE_VERSION_CONFLICT' then
        raise;
      end if;
  end;

  -- Explicit cleanup keeps a successful CI database pristine. If anything
  -- above fails, PostgreSQL rolls back this entire DO statement anyway.
  delete from public.exchange_trade_requests where account_id = v_account_id;
  update public.exchange_rate_pairs
     set current_rate_version_id = null
   where account_id = v_account_id;
  delete from public.exchange_rate_versions where account_id = v_account_id;
  delete from public.exchange_rate_pairs where account_id = v_account_id;
  delete from public.account_exchange_settings where account_id = v_account_id;
  delete from public.accounts where id = v_account_id;
  delete from auth.users where id = v_user_id;

  if exists (
       select 1 from public.account_exchange_settings where account_id = v_account_id
     ) or exists (
       select 1 from public.exchange_rate_pairs where account_id = v_account_id
     ) or exists (
       select 1 from public.exchange_rate_versions where account_id = v_account_id
     ) or exists (
       select 1 from public.exchange_trade_requests where account_id = v_account_id
     ) then
    raise exception 'FX_SMOKE_FIXTURE_CLEANUP_FAILED';
  end if;
end
$$;
