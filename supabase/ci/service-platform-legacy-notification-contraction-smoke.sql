-- Service Platform Phase 5 legacy notification write contraction smoke.
-- Proves fail-closed retirement, active-route suppression, legacy fallback
-- resumption, and guarded rollback for an unlinked active event.
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_account_id uuid;
  v_contact_id uuid;
  v_intent_id uuid;
  v_change_request_id uuid;
  v_count integer;
  v_blocked boolean := false;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    v_user_id,
    'service-platform-phase5-' || replace(v_user_id::text, '-', '') || '@example.invalid',
    '{}'::jsonb
  );

  select id into v_account_id
  from public.accounts
  where owner_user_id = v_user_id;

  if v_account_id is null then
    insert into public.accounts (name, owner_user_id)
    values ('Service Platform Phase 5 smoke', v_user_id)
    returning id into v_account_id;
  end if;

  insert into public.contacts (account_id, user_id, phone, name)
  values (
    v_account_id,
    v_user_id,
    '+1555' || substr(replace(v_user_id::text, '-', ''), 1, 7),
    'Phase 5 Smoke Contact'
  )
  returning id into v_contact_id;

  insert into public.customer_intents (
    account_id,
    contact_id,
    direction,
    service_hint,
    status,
    idempotency_key
  ) values (
    v_account_id,
    v_contact_id,
    'request',
    'phase 5 legacy contraction smoke',
    'new',
    'phase5-intent-' || v_user_id::text
  )
  returning id into v_intent_id;

  insert into public.change_requests (
    account_id,
    code,
    target_type,
    target_id,
    intent,
    proposed_payload,
    idempotency_key,
    confirmation_code,
    action_key,
    action_version
  ) values (
    v_account_id,
    914000,
    'service_intent',
    v_intent_id,
    'update',
    '{}'::jsonb,
    'phase5-change-' || v_user_id::text,
    '914000',
    'intents.decision.apply',
    1
  )
  returning id into v_change_request_id;

  insert into public.business_event_delivery_controls (
    account_id,
    route_key,
    mode,
    legacy_notification_write_enabled
  ) values (
    v_account_id,
    'service_request_customer_whatsapp',
    'active',
    true
  );

  -- A route with no parity evidence must not be allowed to retire fallback writes.
  begin
    perform public.set_business_event_legacy_notification_write_enabled(
      v_account_id,
      'service_request_customer_whatsapp',
      false
    );
  exception
    when others then
      if sqlerrm like 'BUSINESS_EVENT_LEGACY_WRITE_RETIREMENT_NOT_READY:%' then
        v_blocked := true;
      else
        raise;
      end if;
  end;

  if not v_blocked then
    raise exception 'PHASE5_RETIREMENT_DID_NOT_FAIL_CLOSED';
  end if;

  -- Directly set the fixture flag so the trigger behavior can be exercised
  -- without manufacturing historical 4/4 parity evidence in this focused smoke.
  update public.business_event_delivery_controls
     set legacy_notification_write_enabled = false
   where account_id = v_account_id
     and route_key = 'service_request_customer_whatsapp';

  insert into public.customer_intent_notifications (
    account_id,
    intent_id,
    change_request_id,
    contact_id,
    event_type,
    message_text
  ) values (
    v_account_id,
    v_intent_id,
    v_change_request_id,
    v_contact_id,
    'approved_and_applied',
    '__BUSINESS_EVENT_RENDER_AT_DELIVERY__'
  );

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and change_request_id = v_change_request_id
    and event_type = 'approved_and_applied';

  if v_count <> 0 then
    raise exception 'PHASE5_ACTIVE_ROUTE_STILL_DUAL_WRITES:%', v_count;
  end if;

  -- Legacy mode must automatically resume the historical fallback path even
  -- while the retirement preference remains false.
  update public.business_event_delivery_controls
     set mode = 'legacy'
   where account_id = v_account_id
     and route_key = 'service_request_customer_whatsapp';

  insert into public.customer_intent_notifications (
    account_id,
    intent_id,
    change_request_id,
    contact_id,
    event_type,
    message_text
  ) values (
    v_account_id,
    v_intent_id,
    v_change_request_id,
    v_contact_id,
    'matched',
    '__BUSINESS_EVENT_RENDER_AT_DELIVERY__'
  );

  select count(*) into v_count
  from public.customer_intent_notifications
  where account_id = v_account_id
    and change_request_id = v_change_request_id
    and event_type = 'matched';

  if v_count <> 1 then
    raise exception 'PHASE5_LEGACY_FALLBACK_DID_NOT_RESUME:%', v_count;
  end if;

  update public.business_event_delivery_controls
     set mode = 'active'
   where account_id = v_account_id
     and route_key = 'service_request_customer_whatsapp';

  insert into public.business_event_outbox (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    audience,
    channel,
    contact_id,
    correlation_id,
    payload,
    delivery_mode,
    status,
    dedupe_key
  ) values (
    v_account_id,
    'service_request.approved',
    1,
    'service_intent',
    v_intent_id::text,
    'customer',
    'whatsapp',
    v_contact_id,
    v_change_request_id::text,
    '{}'::jsonb,
    'active',
    'pending',
    'service_request.approved:v1:phase5:' || v_intent_id::text
  );

  v_blocked := false;
  begin
    update public.business_event_outbox
       set delivery_mode = 'shadow'
     where account_id = v_account_id
       and dedupe_key = 'service_request.approved:v1:phase5:' || v_intent_id::text;
  exception
    when others then
      if sqlerrm like 'BUSINESS_EVENT_ROLLBACK_FALLBACK_MISSING:%' then
        v_blocked := true;
      else
        raise;
      end if;
  end;

  if not v_blocked then
    raise exception 'PHASE5_UNLINKED_ROLLBACK_WAS_NOT_BLOCKED';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.set_business_event_legacy_notification_write_enabled(uuid,text,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.set_business_event_legacy_notification_write_enabled(uuid,text,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.set_business_event_legacy_notification_write_enabled(uuid,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'PHASE5_RETIREMENT_RPC_PRIVILEGES_UNSAFE';
  end if;

  delete from public.accounts where id = v_account_id;
  delete from auth.users where id = v_user_id;
end
$$;
