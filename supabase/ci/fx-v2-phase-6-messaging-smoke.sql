-- FX V2 Phase 6 messaging/outbox acceptance smoke.
--
-- Verifies that authoritative trade lifecycle transitions atomically create
-- exactly one durable customer event, that the legacy intent-only claim path
-- cannot steal FX rows, and that both customer directions preserve the frozen
-- Phase 2 rate semantics used later by the deterministic renderer.
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_account_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_base_currency_id uuid;
  v_quote_currency_id uuid;
  v_pair_id uuid;
  v_publish jsonb;
  v_rate_version_id uuid;
  v_buy jsonb;
  v_buy_retry jsonb;
  v_sell jsonb;
  v_buy_id uuid;
  v_sell_id uuid;
  v_result jsonb;
  v_count integer;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    v_user_id,
    'fx-v2-phase6-' || replace(v_user_id::text, '-', '') || '@example.invalid',
    '{}'::jsonb
  );

  select id into v_account_id
  from public.accounts
  where owner_user_id = v_user_id;

  if v_account_id is null then
    insert into public.accounts (name, owner_user_id)
    values ('FX V2 phase 6 messaging smoke', v_user_id)
    returning id into v_account_id;
  end if;

  insert into public.contacts (account_id, user_id, phone, name)
  values (
    v_account_id,
    v_user_id,
    '+967700' || substr(replace(v_user_id::text, '-', ''), 1, 6),
    'FX Phase 6 Customer'
  ) returning id into v_contact_id;

  insert into public.conversations (account_id, user_id, contact_id, status)
  values (v_account_id, v_user_id, v_contact_id, 'open')
  returning id into v_conversation_id;

  select id into v_base_currency_id
  from public.currencies
  where account_id = v_account_id and code = 'SAR';

  select id into v_quote_currency_id
  from public.currencies
  where account_id = v_account_id and code = 'YER';

  if v_base_currency_id is null or v_quote_currency_id is null then
    raise exception 'FX_PHASE6_DEFAULT_CURRENCIES_MISSING';
  end if;

  insert into public.account_exchange_settings (
    account_id, base_currency_id, created_by, updated_by
  ) values (
    v_account_id, v_base_currency_id, v_user_id, v_user_id
  );

  insert into public.exchange_rate_pairs (
    account_id, base_currency_id, quote_currency_id, created_by, updated_by
  ) values (
    v_account_id, v_base_currency_id, v_quote_currency_id, v_user_id, v_user_id
  ) returning id into v_pair_id;

  select public.publish_exchange_rate_pair_version_v2(
    v_account_id,
    v_pair_id,
    0,
    425,
    428,
    'manual',
    null,
    'Phase 6 messaging smoke',
    v_user_id
  ) into v_publish;
  v_rate_version_id := (v_publish->>'version_id')::uuid;

  -- customer_buy must snapshot the business SELL rate = 428.
  select public.create_exchange_trade_request_v2(
    v_account_id,
    v_pair_id,
    'customer_buy',
    'base',
    1000,
    'fx-phase6-buy-0001',
    v_rate_version_id,
    v_contact_id,
    v_conversation_id,
    jsonb_build_object('source', 'phase6-smoke')
  ) into v_buy;
  v_buy_id := (v_buy->>'request_id')::uuid;

  if (v_buy->>'effective_rate')::numeric <> 428
     or (v_buy->>'base_amount')::numeric <> 1000
     or (v_buy->>'quote_amount')::numeric <> 428000 then
    raise exception 'FX_PHASE6_BUY_SNAPSHOT_WRONG: %', v_buy;
  end if;

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and fx_trade_request_id = v_buy_id
    and event_type = 'exchange_rate.trade.pending';
  if v_count <> 1 then
    raise exception 'FX_PHASE6_PENDING_EVENT_MISSING_OR_DUPLICATED: %', v_count;
  end if;

  -- Exact mutation retry must not duplicate the lifecycle event.
  select public.create_exchange_trade_request_v2(
    v_account_id,
    v_pair_id,
    'customer_buy',
    'base',
    1000,
    'fx-phase6-buy-0001',
    v_rate_version_id,
    v_contact_id,
    v_conversation_id,
    jsonb_build_object('source', 'phase6-smoke')
  ) into v_buy_retry;

  if (v_buy_retry->>'request_id')::uuid <> v_buy_id
     or not (v_buy_retry->>'idempotent')::boolean then
    raise exception 'FX_PHASE6_BUY_IDEMPOTENCY_FAILED: %', v_buy_retry;
  end if;

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and fx_trade_request_id = v_buy_id
    and event_type = 'exchange_rate.trade.pending';
  if v_count <> 1 then
    raise exception 'FX_PHASE6_PENDING_EVENT_RETRY_DUPLICATED: %', v_count;
  end if;

  select public.decide_exchange_trade_request_v2(
    v_account_id,
    v_buy_id,
    'pending_admin',
    'approve',
    null,
    'phase 6 approval',
    v_user_id
  ) into v_result;

  if v_result->>'status' <> 'approved_for_contact' then
    raise exception 'FX_PHASE6_APPROVAL_STATUS_WRONG: %', v_result;
  end if;

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and fx_trade_request_id = v_buy_id
    and event_type = 'exchange_rate.trade.approved_for_contact';
  if v_count <> 1 then
    raise exception 'FX_PHASE6_APPROVAL_EVENT_MISSING: %', v_count;
  end if;

  if exists (
    select 1
    from public.customer_intent_notifications
    where account_id = v_account_id
      and fx_trade_request_id = v_buy_id
      and event_type = 'exchange_rate.trade.completed'
  ) then
    raise exception 'FX_PHASE6_COMPLETED_EMITTED_BEFORE_COMPLETION';
  end if;

  select public.complete_exchange_trade_request_v2(
    v_account_id,
    v_buy_id,
    v_user_id
  ) into v_result;

  if v_result->>'status' <> 'completed' then
    raise exception 'FX_PHASE6_COMPLETE_STATUS_WRONG: %', v_result;
  end if;

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and fx_trade_request_id = v_buy_id
    and event_type = 'exchange_rate.trade.completed';
  if v_count <> 1 then
    raise exception 'FX_PHASE6_COMPLETED_EVENT_MISSING: %', v_count;
  end if;

  -- customer_sell must snapshot the business BUY rate = 425.
  select public.create_exchange_trade_request_v2(
    v_account_id,
    v_pair_id,
    'customer_sell',
    'base',
    1000,
    'fx-phase6-sell-0002',
    v_rate_version_id,
    v_contact_id,
    v_conversation_id,
    jsonb_build_object('source', 'phase6-smoke')
  ) into v_sell;
  v_sell_id := (v_sell->>'request_id')::uuid;

  if (v_sell->>'effective_rate')::numeric <> 425
     or (v_sell->>'base_amount')::numeric <> 1000
     or (v_sell->>'quote_amount')::numeric <> 425000 then
    raise exception 'FX_PHASE6_SELL_SNAPSHOT_WRONG: %', v_sell;
  end if;

  select public.decide_exchange_trade_request_v2(
    v_account_id,
    v_sell_id,
    'pending_admin',
    'reject',
    null,
    'phase 6 rejection',
    v_user_id
  ) into v_result;

  if v_result->>'status' <> 'rejected' then
    raise exception 'FX_PHASE6_REJECT_STATUS_WRONG: %', v_result;
  end if;

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and fx_trade_request_id = v_sell_id
    and event_type = 'exchange_rate.trade.rejected';
  if v_count <> 1 then
    raise exception 'FX_PHASE6_REJECT_EVENT_MISSING: %', v_count;
  end if;

  -- Intent-only claim RPC must not claim or mutate FX rows.
  select count(*) into v_count
  from public.claim_customer_intent_notifications(v_account_id, null, 100);
  if v_count <> 0 then
    raise exception 'FX_PHASE6_LEGACY_CLAIM_STOLE_FX_EVENT: %', v_count;
  end if;

  if exists (
    select 1
    from public.customer_intent_notifications
    where account_id = v_account_id
      and fx_trade_request_id in (v_buy_id, v_sell_id)
      and status <> 'pending'
  ) then
    raise exception 'FX_PHASE6_OUTBOX_STATUS_MUTATED_BY_LEGACY_CLAIM';
  end if;

  -- Successful smoke leaves the local CI database pristine.
  delete from public.exchange_trade_requests where account_id = v_account_id;
  update public.exchange_rate_pairs
     set current_rate_version_id = null
   where account_id = v_account_id;
  delete from public.exchange_rate_versions where account_id = v_account_id;
  delete from public.exchange_rate_pairs where account_id = v_account_id;
  delete from public.account_exchange_settings where account_id = v_account_id;
  delete from public.conversations where id = v_conversation_id;
  delete from public.contacts where id = v_contact_id;
  delete from public.accounts where id = v_account_id;
  delete from auth.users where id = v_user_id;

  if exists (
    select 1 from public.customer_intent_notifications where account_id = v_account_id
  ) then
    raise exception 'FX_PHASE6_OUTBOX_CLEANUP_FAILED';
  end if;
end
$$;
