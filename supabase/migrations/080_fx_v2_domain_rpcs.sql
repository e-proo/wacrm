-- ============================================================
-- 080_fx_v2_domain_rpcs.sql — deterministic FX V2 operations
--
-- Installs the concurrency-critical server-side primitives for
-- pair-centric FX V2. These RPCs are service-role only.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Publish a new immutable rate version atomically
-- ------------------------------------------------------------
create or replace function public.publish_exchange_rate_pair_version_v2(
  p_account_id uuid,
  p_pair_id uuid,
  p_expected_lock_version bigint,
  p_business_buy_rate numeric,
  p_business_sell_rate numeric,
  p_source text,
  p_source_change_request_id uuid,
  p_notes_internal text,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pair record;
  v_existing record;
  v_version_id uuid;
  v_next_version integer;
  v_new_lock_version bigint;
begin
  if p_business_buy_rate is null or p_business_buy_rate <= 0 then
    raise exception 'FX_INVALID_BUY_RATE' using errcode = 'P0001';
  end if;
  if p_business_sell_rate is null or p_business_sell_rate <= 0 then
    raise exception 'FX_INVALID_SELL_RATE' using errcode = 'P0001';
  end if;
  if p_source not in ('manual', 'admin_agent', 'external', 'migration') then
    raise exception 'FX_INVALID_RATE_SOURCE' using errcode = 'P0001';
  end if;

  if p_source_change_request_id is not null then
    if not exists (
      select 1
      from public.change_requests cr
      where cr.id = p_source_change_request_id
        and cr.account_id = p_account_id
    ) then
      raise exception 'FX_CHANGE_REQUEST_NOT_FOUND' using errcode = 'P0001';
    end if;

    select id, pair_id, business_buy_rate, business_sell_rate, source, version_number
      into v_existing
      from public.exchange_rate_versions
     where source_change_request_id = p_source_change_request_id;

    if found then
      if v_existing.pair_id <> p_pair_id
         or v_existing.business_buy_rate <> p_business_buy_rate
         or v_existing.business_sell_rate <> p_business_sell_rate
         or v_existing.source <> p_source then
        raise exception 'FX_CHANGE_REQUEST_REUSED' using errcode = 'P0001';
      end if;

      select lock_version into v_new_lock_version
        from public.exchange_rate_pairs
       where account_id = p_account_id
         and id = p_pair_id;

      return jsonb_build_object(
        'version_id', v_existing.id,
        'version_number', v_existing.version_number,
        'lock_version', v_new_lock_version,
        'idempotent', true
      );
    end if;
  end if;

  select
      p.id,
      p.status,
      p.lock_version,
      b.status as base_status,
      q.status as quote_status
    into v_pair
    from public.exchange_rate_pairs p
    join public.currencies b
      on b.account_id = p.account_id and b.id = p.base_currency_id
    join public.currencies q
      on q.account_id = p.account_id and q.id = p.quote_currency_id
   where p.account_id = p_account_id
     and p.id = p_pair_id
   for update of p;

  if not found then
    raise exception 'FX_PAIR_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_pair.status <> 'active' then
    raise exception 'FX_PAIR_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_pair.base_status <> 'active' or v_pair.quote_status <> 'active' then
    raise exception 'FX_PAIR_CURRENCY_DISABLED' using errcode = 'P0001';
  end if;
  if p_expected_lock_version is null
     or v_pair.lock_version <> p_expected_lock_version then
    raise exception 'FX_PAIR_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) + 1
    into v_next_version
    from public.exchange_rate_versions
   where pair_id = p_pair_id;

  begin
    insert into public.exchange_rate_versions (
      account_id,
      pair_id,
      version_number,
      business_buy_rate,
      business_sell_rate,
      source,
      source_change_request_id,
      notes_internal,
      created_by
    ) values (
      p_account_id,
      p_pair_id,
      v_next_version,
      p_business_buy_rate,
      p_business_sell_rate,
      p_source,
      p_source_change_request_id,
      p_notes_internal,
      p_actor_user_id
    )
    returning id into v_version_id;
  exception when unique_violation then
    if p_source_change_request_id is null then
      raise;
    end if;

    select id, pair_id, business_buy_rate, business_sell_rate, source, version_number
      into v_existing
      from public.exchange_rate_versions
     where source_change_request_id = p_source_change_request_id;

    if not found
       or v_existing.pair_id <> p_pair_id
       or v_existing.business_buy_rate <> p_business_buy_rate
       or v_existing.business_sell_rate <> p_business_sell_rate
       or v_existing.source <> p_source then
      raise exception 'FX_CHANGE_REQUEST_REUSED' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'version_id', v_existing.id,
      'version_number', v_existing.version_number,
      'lock_version', v_pair.lock_version,
      'idempotent', true
    );
  end;

  update public.exchange_rate_pairs
     set current_rate_version_id = v_version_id,
         lock_version = lock_version + 1,
         updated_by = p_actor_user_id
   where account_id = p_account_id
     and id = p_pair_id
  returning lock_version into v_new_lock_version;

  perform public.append_service_activity_event(
    p_account_id,
    'exchange_rate_pair',
    p_pair_id,
    'exchange_rate.version.published',
    case when p_actor_user_id is null then 'system' else 'user' end,
    coalesce(p_actor_user_id::text, 'system'),
    jsonb_build_object(
      'version_id', v_version_id,
      'version_number', v_next_version,
      'business_buy_rate', p_business_buy_rate::text,
      'business_sell_rate', p_business_sell_rate::text,
      'source', p_source,
      'source_change_request_id', p_source_change_request_id
    )
  );

  return jsonb_build_object(
    'version_id', v_version_id,
    'version_number', v_next_version,
    'lock_version', v_new_lock_version,
    'idempotent', false
  );
end;
$$;

revoke all on function public.publish_exchange_rate_pair_version_v2(
  uuid, uuid, bigint, numeric, numeric, text, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.publish_exchange_rate_pair_version_v2(
  uuid, uuid, bigint, numeric, numeric, text, uuid, text, uuid
) to service_role;

-- ------------------------------------------------------------
-- 2) Create an idempotent customer trade request
-- ------------------------------------------------------------
create or replace function public.create_exchange_trade_request_v2(
  p_account_id uuid,
  p_pair_id uuid,
  p_side text,
  p_amount_basis text,
  p_requested_amount numeric,
  p_idempotency_key text,
  p_expected_rate_version_id uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pair record;
  v_version record;
  v_existing record;
  v_inserted record;
  v_effective_rate numeric;
  v_base_amount numeric;
  v_quote_amount numeric;
begin
  if p_side not in ('customer_buy', 'customer_sell') then
    raise exception 'FX_INVALID_TRADE_SIDE' using errcode = 'P0001';
  end if;
  if p_amount_basis not in ('base', 'quote') then
    raise exception 'FX_INVALID_AMOUNT_BASIS' using errcode = 'P0001';
  end if;
  if p_requested_amount is null or p_requested_amount <= 0 then
    raise exception 'FX_INVALID_TRADE_AMOUNT' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8 then
    raise exception 'FX_INVALID_IDEMPOTENCY_KEY' using errcode = 'P0001';
  end if;
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'FX_INVALID_METADATA' using errcode = 'P0001';
  end if;

  select * into v_existing
    from public.exchange_trade_requests
   where account_id = p_account_id
     and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.pair_id <> p_pair_id
       or v_existing.side <> p_side
       or v_existing.amount_basis <> p_amount_basis
       or v_existing.requested_amount <> p_requested_amount
       or v_existing.contact_id is distinct from p_contact_id
       or v_existing.conversation_id is distinct from p_conversation_id then
      raise exception 'FX_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'request_id', v_existing.id,
      'code', v_existing.code::text,
      'rate_version_id', v_existing.rate_version_id,
      'effective_rate', v_existing.effective_rate::text,
      'base_amount', v_existing.base_amount::text,
      'quote_amount', v_existing.quote_amount::text,
      'status', v_existing.status,
      'idempotent', true
    );
  end if;

  if p_contact_id is not null and not exists (
    select 1 from public.contacts c
     where c.id = p_contact_id and c.account_id = p_account_id
  ) then
    raise exception 'FX_CONTACT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_conversation_id is not null then
    if not exists (
      select 1 from public.conversations c
       where c.id = p_conversation_id and c.account_id = p_account_id
    ) then
      raise exception 'FX_CONVERSATION_NOT_FOUND' using errcode = 'P0001';
    end if;

    if p_contact_id is not null and not exists (
      select 1 from public.conversations c
       where c.id = p_conversation_id
         and c.account_id = p_account_id
         and c.contact_id = p_contact_id
    ) then
      raise exception 'FX_CONVERSATION_CONTACT_MISMATCH' using errcode = 'P0001';
    end if;
  end if;

  select
      p.id,
      p.status,
      p.current_rate_version_id,
      b.decimal_digits as base_digits,
      q.decimal_digits as quote_digits,
      b.status as base_status,
      q.status as quote_status
    into v_pair
    from public.exchange_rate_pairs p
    join public.currencies b
      on b.account_id = p.account_id and b.id = p.base_currency_id
    join public.currencies q
      on q.account_id = p.account_id and q.id = p.quote_currency_id
   where p.account_id = p_account_id
     and p.id = p_pair_id
   for share of p;

  if not found then
    raise exception 'FX_PAIR_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_pair.status <> 'active' then
    raise exception 'FX_PAIR_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_pair.base_status <> 'active' or v_pair.quote_status <> 'active' then
    raise exception 'FX_PAIR_CURRENCY_DISABLED' using errcode = 'P0001';
  end if;
  if v_pair.current_rate_version_id is null then
    raise exception 'FX_RATE_NOT_PUBLISHED' using errcode = 'P0001';
  end if;
  if p_expected_rate_version_id is not null
     and p_expected_rate_version_id <> v_pair.current_rate_version_id then
    raise exception 'FX_RATE_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  select id, business_buy_rate, business_sell_rate
    into v_version
    from public.exchange_rate_versions
   where account_id = p_account_id
     and pair_id = p_pair_id
     and id = v_pair.current_rate_version_id;

  if not found then
    raise exception 'FX_RATE_VERSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_effective_rate := case
    when p_side = 'customer_buy' then v_version.business_sell_rate
    else v_version.business_buy_rate
  end;

  if p_amount_basis = 'base' then
    v_base_amount := round(p_requested_amount, v_pair.base_digits);
    v_quote_amount := round(v_base_amount * v_effective_rate, v_pair.quote_digits);
  else
    v_quote_amount := round(p_requested_amount, v_pair.quote_digits);
    v_base_amount := round(v_quote_amount / v_effective_rate, v_pair.base_digits);
  end if;

  if v_base_amount <= 0 or v_quote_amount <= 0 then
    raise exception 'FX_AMOUNT_ROUNDS_TO_ZERO' using errcode = 'P0001';
  end if;

  begin
    insert into public.exchange_trade_requests (
      account_id,
      pair_id,
      side,
      amount_basis,
      requested_amount,
      rate_version_id,
      effective_rate,
      base_amount,
      quote_amount,
      status,
      idempotency_key,
      contact_id,
      conversation_id,
      metadata
    ) values (
      p_account_id,
      p_pair_id,
      p_side,
      p_amount_basis,
      p_requested_amount,
      v_version.id,
      v_effective_rate,
      v_base_amount,
      v_quote_amount,
      'pending_admin',
      btrim(p_idempotency_key),
      p_contact_id,
      p_conversation_id,
      coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into v_inserted;
  exception when unique_violation then
    select * into v_existing
      from public.exchange_trade_requests
     where account_id = p_account_id
       and idempotency_key = btrim(p_idempotency_key);

    if not found
       or v_existing.pair_id <> p_pair_id
       or v_existing.side <> p_side
       or v_existing.amount_basis <> p_amount_basis
       or v_existing.requested_amount <> p_requested_amount
       or v_existing.contact_id is distinct from p_contact_id
       or v_existing.conversation_id is distinct from p_conversation_id then
      raise exception 'FX_IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'request_id', v_existing.id,
      'code', v_existing.code::text,
      'rate_version_id', v_existing.rate_version_id,
      'effective_rate', v_existing.effective_rate::text,
      'base_amount', v_existing.base_amount::text,
      'quote_amount', v_existing.quote_amount::text,
      'status', v_existing.status,
      'idempotent', true
    );
  end;

  perform public.append_service_activity_event(
    p_account_id,
    'exchange_trade_request',
    v_inserted.id,
    'exchange_trade_request.created',
    'system',
    'customer_runtime',
    jsonb_build_object(
      'pair_id', p_pair_id,
      'side', p_side,
      'amount_basis', p_amount_basis,
      'rate_version_id', v_version.id,
      'effective_rate', v_effective_rate::text,
      'base_amount', v_base_amount::text,
      'quote_amount', v_quote_amount::text
    )
  );

  return jsonb_build_object(
    'request_id', v_inserted.id,
    'code', v_inserted.code::text,
    'rate_version_id', v_inserted.rate_version_id,
    'effective_rate', v_inserted.effective_rate::text,
    'base_amount', v_inserted.base_amount::text,
    'quote_amount', v_inserted.quote_amount::text,
    'status', v_inserted.status,
    'idempotent', false
  );
end;
$$;

revoke all on function public.create_exchange_trade_request_v2(
  uuid, uuid, text, text, numeric, text, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.create_exchange_trade_request_v2(
  uuid, uuid, text, text, numeric, text, uuid, uuid, uuid, jsonb
) to service_role;

-- ------------------------------------------------------------
-- 3) Deterministic request lifecycle transitions
-- ------------------------------------------------------------
create or replace function public.decide_exchange_trade_request_v2(
  p_account_id uuid,
  p_request_id uuid,
  p_expected_status text,
  p_decision text,
  p_change_request_id uuid,
  p_note text,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_target_status text;
begin
  if p_decision = 'approve' then
    v_target_status := 'approved_for_contact';
  elsif p_decision = 'reject' then
    v_target_status := 'rejected';
  else
    raise exception 'FX_INVALID_DECISION' using errcode = 'P0001';
  end if;

  if p_change_request_id is not null and not exists (
    select 1 from public.change_requests cr
     where cr.id = p_change_request_id and cr.account_id = p_account_id
  ) then
    raise exception 'FX_CHANGE_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  select id, status, decision_change_request_id into v_row
    from public.exchange_trade_requests
   where account_id = p_account_id
     and id = p_request_id
   for update;

  if not found then
    raise exception 'FX_TRADE_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_row.decision_change_request_id is not null then
    if v_row.decision_change_request_id = p_change_request_id
       and v_row.status = v_target_status then
      return jsonb_build_object(
        'request_id', p_request_id,
        'status', v_row.status,
        'idempotent', true
      );
    end if;
    raise exception 'FX_TRADE_ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  if v_row.status <> p_expected_status or v_row.status <> 'pending_admin' then
    raise exception 'FX_TRADE_STATUS_CONFLICT' using errcode = 'P0001';
  end if;

  update public.exchange_trade_requests
     set status = v_target_status,
         decision_change_request_id = p_change_request_id,
         decision_note = p_note,
         decided_by = p_actor_user_id,
         decided_at = now()
   where account_id = p_account_id
     and id = p_request_id;

  perform public.append_service_activity_event(
    p_account_id,
    'exchange_trade_request',
    p_request_id,
    case when p_decision = 'approve'
      then 'exchange_trade_request.approved_for_contact'
      else 'exchange_trade_request.rejected'
    end,
    case when p_actor_user_id is null then 'system' else 'user' end,
    coalesce(p_actor_user_id::text, 'system'),
    jsonb_build_object(
      'decision', p_decision,
      'change_request_id', p_change_request_id,
      'note', p_note
    )
  );

  return jsonb_build_object(
    'request_id', p_request_id,
    'status', v_target_status,
    'idempotent', false
  );
end;
$$;

revoke all on function public.decide_exchange_trade_request_v2(
  uuid, uuid, text, text, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.decide_exchange_trade_request_v2(
  uuid, uuid, text, text, uuid, text, uuid
) to service_role;

create or replace function public.complete_exchange_trade_request_v2(
  p_account_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.exchange_trade_requests
   where account_id = p_account_id
     and id = p_request_id
   for update;

  if not found then
    raise exception 'FX_TRADE_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_status = 'completed' then
    return jsonb_build_object('request_id', p_request_id, 'status', 'completed', 'idempotent', true);
  end if;
  if v_status <> 'approved_for_contact' then
    raise exception 'FX_TRADE_STATUS_CONFLICT' using errcode = 'P0001';
  end if;

  update public.exchange_trade_requests
     set status = 'completed', completed_at = now()
   where account_id = p_account_id and id = p_request_id;

  perform public.append_service_activity_event(
    p_account_id,
    'exchange_trade_request',
    p_request_id,
    'exchange_trade_request.completed',
    case when p_actor_user_id is null then 'system' else 'user' end,
    coalesce(p_actor_user_id::text, 'system'),
    '{}'::jsonb
  );

  return jsonb_build_object('request_id', p_request_id, 'status', 'completed', 'idempotent', false);
end;
$$;

revoke all on function public.complete_exchange_trade_request_v2(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_exchange_trade_request_v2(uuid, uuid, uuid)
  to service_role;

create or replace function public.cancel_exchange_trade_request_v2(
  p_account_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.exchange_trade_requests
   where account_id = p_account_id
     and id = p_request_id
   for update;

  if not found then
    raise exception 'FX_TRADE_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_status = 'cancelled' then
    return jsonb_build_object('request_id', p_request_id, 'status', 'cancelled', 'idempotent', true);
  end if;
  if v_status not in ('pending_admin', 'approved_for_contact') then
    raise exception 'FX_TRADE_STATUS_CONFLICT' using errcode = 'P0001';
  end if;

  update public.exchange_trade_requests
     set status = 'cancelled', cancelled_at = now()
   where account_id = p_account_id and id = p_request_id;

  perform public.append_service_activity_event(
    p_account_id,
    'exchange_trade_request',
    p_request_id,
    'exchange_trade_request.cancelled',
    case when p_actor_user_id is null then 'system' else 'user' end,
    coalesce(p_actor_user_id::text, 'system'),
    '{}'::jsonb
  );

  return jsonb_build_object('request_id', p_request_id, 'status', 'cancelled', 'idempotent', false);
end;
$$;

revoke all on function public.cancel_exchange_trade_request_v2(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_exchange_trade_request_v2(uuid, uuid, uuid)
  to service_role;
