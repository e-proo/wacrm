-- Intents / Service Requests controlled cutover safety smoke.
-- One transactional DO statement so failures roll back automatically.
DO $$
DECLARE
  v_account_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_readiness jsonb;
  v_producer_def text;
  v_route_def text;
  v_activation_blocked boolean := false;
BEGIN
  v_readiness :=
    public.inspect_intents_business_event_cutover_readiness(v_account_id);

  IF v_readiness ->> 'mode' <> 'legacy' THEN
    RAISE EXCEPTION 'Intents cutover must default to legacy: %', v_readiness;
  END IF;

  IF coalesce((v_readiness ->> 'ready')::boolean, true) THEN
    RAISE EXCEPTION 'Intents cutover must not be ready without parity evidence: %',
      v_readiness;
  END IF;

  IF (v_readiness ->> 'required_event_types')::integer <> 4
     OR (v_readiness ->> 'matched_event_types')::integer <> 0
     OR jsonb_array_length(v_readiness -> 'missing_event_types') <> 4 THEN
    RAISE EXCEPTION 'Intents readiness event contract drifted: %', v_readiness;
  END IF;

  BEGIN
    PERFORM public.set_intents_business_event_delivery_mode(
      v_account_id,
      'active'
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'INTENTS_BUSINESS_EVENT_CUTOVER_NOT_READY:%' THEN
        v_activation_blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_activation_blocked THEN
    RAISE EXCEPTION 'Intents activation was not blocked without evidence';
  END IF;

  SELECT pg_get_functiondef(
    'public.enqueue_service_intent_business_event_shadow()'::regprocedure
  ) INTO v_producer_def;

  IF position('intents.decision.apply' in v_producer_def) = 0
     OR position('service_intent' in v_producer_def) = 0 THEN
    RAISE EXCEPTION 'Intents producer ownership guard is missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.route_service_intent_customer_business_event()'::regprocedure
  ) INTO v_route_def;

  IF position('intents.decision.apply' in v_route_def) = 0
     OR position('service_request_customer_whatsapp' in v_route_def) = 0 THEN
    RAISE EXCEPTION 'Intents route ownership/control guard is missing';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Intents readiness privileges are unsafe';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Intents mode-switch privileges are unsafe';
  END IF;
END
$$;
