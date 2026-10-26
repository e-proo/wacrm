begin;

do $$
declare v_reserve text; v_record text;
begin
  if to_regclass('public.whatsapp_connection_guardrails') is null or to_regclass('public.whatsapp_guardrail_events') is null then raise exception 'OW-10 guardrail tables missing'; end if;
  if not (select relrowsecurity from pg_class where oid='public.whatsapp_connection_guardrails'::regclass) or not (select relrowsecurity from pg_class where oid='public.whatsapp_guardrail_events'::regclass) then raise exception 'OW-10 RLS missing'; end if;
  if has_table_privilege('anon','public.whatsapp_connection_guardrails','select') or has_table_privilege('authenticated','public.whatsapp_guardrail_events','select') then raise exception 'OW-10 server-only tables leaked'; end if;
  if has_function_privilege('anon','public.reserve_openwa_guardrail_send(uuid,uuid,text,text)','execute') or has_function_privilege('authenticated','public.reserve_openwa_guardrail_send(uuid,uuid,text,text)','execute') then raise exception 'OW-10 reserve RPC leaked'; end if;
  if not has_function_privilege('service_role','public.reserve_openwa_guardrail_send(uuid,uuid,text,text)','execute') then raise exception 'service_role cannot reserve OW-10 capacity'; end if;
  select pg_get_functiondef('public.reserve_openwa_guardrail_send(uuid,uuid,text,text)'::regprocedure) into v_reserve;
  select pg_get_functiondef('public.record_openwa_guardrail_outcome(uuid,uuid,text,text,boolean,text)'::regprocedure) into v_record;
  if position('pg_advisory_xact_lock' in v_reserve)=0 or position('account_id = p_account_id' in v_reserve)=0 then raise exception 'OW-10 reservation is not atomic/account scoped'; end if;
  if position('manual_paused' in v_reserve)=0 or position('warmup_until' in v_reserve)=0 or position('first_touch_daily_cap' in v_reserve)=0 or position('minimum_interval_ms' in v_reserve)=0 then raise exception 'OW-10 required policy controls missing'; end if;
  if position('failure_rate_threshold' in v_record)=0 or position('circuit_open_until' in v_record)=0 then raise exception 'OW-10 failure circuit breaker missing'; end if;
  raise notice 'OW-10 OpenWA guardrail smoke passed';
end $$;

rollback;
