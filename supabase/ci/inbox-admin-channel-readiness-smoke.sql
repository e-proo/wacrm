BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002251'; other_u uuid:='00000000-0000-4000-8000-000000002252';
 a uuid; other_a uuid; c uuid; c2 uuid; c3 uuid; d timestamptz; cv timestamptz; ep uuid; ch uuid; v jsonb; report jsonb; r jsonb; k uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox225@example.test','{"full_name":"Inbox 225"}'),(other_u,'inbox225other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 SELECT account_id INTO STRICT other_a FROM public.profiles WHERE user_id=other_u;
 INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id,phone_identity,display_name) VALUES('00000000-0000-4000-8000-000000002253',a,'openwa','ready','fixture-private-session','15550000125','Primary fixture') RETURNING id,updated_at INTO c,d;
 INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id,phone_identity,display_name) VALUES('00000000-0000-4000-8000-000000002254',a,'openwa','ready','fixture-other-session','15550000125','Second fixture') RETURNING id INTO c2;
 INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id,phone_identity,display_name) VALUES('00000000-0000-4000-8000-000000002255',other_a,'openwa','ready','fixture-foreign','15550000125','Foreign fixture') RETURNING id INTO c3;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted,webhook_url)
 VALUES(a,c,'openwa','https://fixture-secret.example','fixture-private-key','fixture-private-signature','https://wacrm.example.test/api/whatsapp/openwa/webhook') RETURNING updated_at INTO cv;
 EXECUTE 'SET LOCAL ROLE service_role';
 report=public.inbox_admin_channel_readiness(a,u,NULL,20);
 EXECUTE 'RESET ROLE';
 IF jsonb_array_length(report->'rows')<>(SELECT count(*) FROM public.whatsapp_connections WHERE account_id=a AND archived_at IS NULL) OR report::text LIKE '%fixture-private%' OR report::text LIKE '%15550000125%' OR report::text LIKE '%Foreign fixture%' THEN RAISE EXCEPTION 'scope/redaction %',report; END IF;
 SELECT x INTO STRICT r FROM jsonb_array_elements(report->'rows') x WHERE x->>'id'=c::text;
 IF r->>'identity_verified'<>'false' OR r->>'namespace_kind'<>'none' OR r->>'signed_webhook_configured'<>'true' OR r->>'primary'<>'false' THEN RAISE EXCEPTION 'registry treated as proof %',r; END IF;
 report=public.inbox_admin_channel_readiness(a,u,c,1);
 IF (report->'rows'->0->>'id')<>c2::text THEN RAISE EXCEPTION 'keyset skipped route %',report; END IF;
 BEGIN PERFORM public.inbox_admin_channel_readiness(a,other_u,NULL,20); RAISE EXCEPTION 'foreign actor read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.inbox_admin_channel_readiness(a,u,NULL,31); RAISE EXCEPTION 'unbounded read'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 v=public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000125','fixture-private-session',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
 ep=(v->>'membership_id')::uuid;ch=(v->>'channel_id')::uuid;
 report=public.inbox_admin_channel_readiness(a,u,NULL,20);
 SELECT x INTO STRICT r FROM jsonb_array_elements(report->'rows') x WHERE x->>'id'=c::text;
 IF r->>'identity_verified'<>'true' OR r->>'namespace_contract_verified'<>'true' OR r->>'primary'<>'true' THEN RAISE EXCEPTION 'proof not reflected %',r; END IF;
 SELECT x INTO STRICT r FROM jsonb_array_elements(report->'rows') x WHERE x->>'id'=c2::text;
 IF r->>'handover_blocked'<>'true' OR r->>'channel_id' IS NOT NULL THEN RAISE EXCEPTION 'candidate route inferred %',r; END IF;
 BEGIN PERFORM public.inbox_admin_revoke_openwa_enrollment(a,other_u,c,ep,true,gen_random_uuid()); RAISE EXCEPTION 'foreign actor revoked'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 v=public.inbox_admin_revoke_openwa_enrollment(a,u,c,ep,false,gen_random_uuid());IF v->>'state'<>'conflict' THEN RAISE EXCEPTION 'stale role accepted'; END IF;
 -- Pending action blocks administrative revocation; synthetic intent only.
 INSERT INTO public.inbox_action_intents(account_id,actor_id,request_key,thread_id,conversation_id,channel_id,connection_id,membership_id,provider,action_kind,fingerprint,recipient_hash)
 VALUES(a,u,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),ch,c,ep,'openwa','send',repeat('a',64),repeat('b',64));
 v=public.inbox_admin_revoke_openwa_enrollment(a,u,c,ep,true,gen_random_uuid());
 IF v->>'state'<>'busy' OR NOT EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep AND valid_until IS NULL AND is_primary) THEN RAISE EXCEPTION 'pending action not fenced'; END IF;
 UPDATE public.inbox_action_intents SET state='blocked',finished_at=clock_timestamp() WHERE account_id=a AND membership_id=ep;
 -- Simulated pending durable event: nested transaction is rolled back.
 BEGIN
  SELECT updated_at INTO cv FROM public.whatsapp_connection_credentials WHERE account_id=a AND connection_id=c AND provider='openwa';
  IF public.openwa_enqueue_signed_intake(a,c,'pending-revoke','fixture-private-session',NULL,cv,true,repeat('a',64),repeat('a',100))<>'accepted' THEN RAISE EXCEPTION 'pending fixture not accepted'; END IF;
  v=public.inbox_admin_revoke_openwa_enrollment(a,u,c,ep,true,gen_random_uuid());
  IF v->>'state'<>'busy' THEN RAISE EXCEPTION 'pending durable event not fenced'; END IF;
  RAISE SQLSTATE 'P0002';
 EXCEPTION WHEN no_data_found THEN NULL; END;
 k=gen_random_uuid();
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_admin_revoke_openwa_enrollment(a,u,c,ep,true,k);
 EXECUTE 'RESET ROLE';
 IF v->>'state'<>'revoked' OR EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep AND (valid_until IS NULL OR is_primary))
 OR NOT EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs WHERE membership_id=ep)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_integrity_audit WHERE account_id=a AND actor_id=u AND membership_id=ep AND evidence_ref='operator-revocation:'||k::text)
 OR NOT EXISTS(SELECT 1 FROM public.whatsapp_connections WHERE id=c AND status='ready') THEN RAISE EXCEPTION 'revocation integrity %',v; END IF;
 report=public.inbox_admin_channel_readiness(a,u,NULL,20);
 SELECT x INTO STRICT r FROM jsonb_array_elements(report->'rows') x WHERE x->>'id'=c2::text;
 IF r->>'handover_blocked'<>'true' THEN RAISE EXCEPTION 'revocation bypassed historic proof'; END IF;
 v=public.inbox_admin_revoke_openwa_enrollment(a,u,c,ep,true,k);IF v->>'state'<>'conflict' THEN RAISE EXCEPTION 'stale epoch accepted'; END IF;
 IF has_function_privilege('authenticated','public.inbox_admin_channel_readiness(uuid,uuid,uuid,integer)','EXECUTE') OR has_function_privilege('anon','public.inbox_admin_revoke_openwa_enrollment(uuid,uuid,uuid,uuid,boolean,uuid)','EXECUTE') THEN RAISE EXCEPTION 'browser RPC grant'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
