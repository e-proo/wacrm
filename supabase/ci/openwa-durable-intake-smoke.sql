BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002291'; other_u uuid:='00000000-0000-4000-8000-000000002292';a uuid;b uuid;c uuid;cv timestamptz;v text;j jsonb;rid uuid;tok uuid;rid2 uuid;cipher text:=repeat('a',100);d text:=repeat('a',64);
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'intake229@example.test','{"full_name":"Intake 229"}'),(other_u,'intake229other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;SELECT account_id INTO STRICT b FROM public.profiles WHERE user_id=other_u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','intake229','15550000229') RETURNING id INTO c;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted)
 VALUES(a,c,'openwa','https://fixture.example','fixture','fixture') RETURNING updated_at INTO cv;
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.openwa_enqueue_signed_intake(a,c,'first','intake229',NULL,cv,true,d,cipher);
 EXECUTE 'RESET ROLE';
 IF v<>'accepted' THEN RAISE EXCEPTION 'enqueue %',v; END IF;
 IF public.openwa_enqueue_signed_intake(a,c,'first','intake229',NULL,cv,false,d,cipher)<>'accepted_duplicate'
 OR public.openwa_enqueue_signed_intake(a,c,'first','intake229',NULL,cv,true,repeat('b',64),cipher)<>'conflict'
 OR public.openwa_enqueue_signed_intake(b,c,'first','intake229',NULL,cv,true,d,cipher)<>'binding_changed'
 OR public.openwa_enqueue_signed_intake(a,c,'bad','intake229',NULL,cv-interval '1 second',true,d,cipher)<>'binding_changed'
 THEN RAISE EXCEPTION 'dedup or scope'; END IF;
 SELECT id INTO STRICT rid FROM public.whatsapp_webhook_event_receipts WHERE account_id=a AND connection_id=c AND provider_event_id='first';
 BEGIN UPDATE public.whatsapp_webhook_event_receipts SET processing_started_at=clock_timestamp(),processing_token=gen_random_uuid(),processing_attempts=1 WHERE id=rid;RAISE EXCEPTION 'old sync claimed'; EXCEPTION WHEN lock_not_available THEN NULL; END;
 IF public.openwa_enqueue_signed_intake(a,c,'second','intake229',NULL,cv,false,d,cipher)<>'accepted' THEN RAISE EXCEPTION 'second enqueue'; END IF;
 -- Pending queue remains durable and mode-specific, no processing yet.
 IF public.openwa_claim_signed_intake(false)->>'state'<>'idle' THEN RAISE EXCEPTION 'mode/order mismatch'; END IF;
 EXECUTE 'SET LOCAL ROLE service_role';
 j=public.openwa_claim_signed_intake(true);
 EXECUTE 'RESET ROLE';
 IF j->>'state'<>'claimed' OR (j->>'id')::uuid<>rid OR j->>'ciphertext'<>cipher THEN RAISE EXCEPTION 'claim %',j; END IF;
 tok=(j->>'token')::uuid;
 IF public.openwa_claim_signed_intake(true)->>'state'<>'idle' OR public.openwa_claim_signed_intake(false)->>'state'<>'idle' THEN RAISE EXCEPTION 'concurrent route claim'; END IF;
 IF public.openwa_finish_signed_intake(rid,gen_random_uuid(),NULL)<>'conflict' THEN RAISE EXCEPTION 'foreign lease'; END IF;
 -- Simulate actual handler finalization, then a crash before queue finish.
 UPDATE public.whatsapp_webhook_event_receipts SET processed_at=clock_timestamp(),processing_started_at=NULL,processing_error=NULL WHERE id=rid AND processing_token=tok;
 j=public.openwa_claim_signed_intake(false);IF j->>'state'<>'claimed' THEN RAISE EXCEPTION 'next claim %',j; END IF;
 rid2=(j->>'id')::uuid;tok=(j->>'token')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid AND intake_state='completed' AND intake_ciphertext IS NULL) THEN RAISE EXCEPTION 'finalized crash replayed'; END IF;
 UPDATE public.whatsapp_webhook_event_receipts SET processing_started_at=NULL,processing_error='processing_failed' WHERE id=rid2 AND processing_token=tok;
 IF public.openwa_finish_signed_intake(rid2,tok,'processing_uncertain')<>'review' THEN RAISE EXCEPTION 'uncertain not retained'; END IF;
 IF public.openwa_claim_signed_intake(false)->>'state'<>'idle' OR NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid2 AND intake_state='review' AND intake_ciphertext=cipher AND processed_at IS NULL) THEN RAISE EXCEPTION 'blind retry'; END IF;
 -- A review blocks further claims on this route until an explicit closure.
 IF public.openwa_enqueue_signed_intake(a,c,'blocked','intake229',NULL,cv,true,d,cipher)<>'accepted' THEN RAISE EXCEPTION 'blocked fixture'; END IF;
 IF public.openwa_claim_signed_intake(true)->>'state'<>'idle' THEN RAISE EXCEPTION 'uncertain route not fenced'; END IF;
 BEGIN PERFORM public.openwa_intake_close_unverified(a,other_u,rid2);RAISE EXCEPTION 'foreign close';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 v=public.openwa_intake_close_unverified(a,u,rid2);IF v<>'closed_unverified' THEN RAISE EXCEPTION 'closure outcome %',v; END IF;
 v=public.openwa_intake_close_unverified(a,u,rid2);IF v<>'closed_unverified' THEN RAISE EXCEPTION 'closure retry %',v; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid2 AND intake_closed_by=u AND intake_closed_at IS NOT NULL AND intake_ciphertext=cipher AND processed_at IS NULL AND intake_reason='processing_uncertain') THEN RAISE EXCEPTION 'closure lost evidence'; END IF;
 j=public.openwa_claim_signed_intake(true);IF j->>'state'<>'claimed' THEN RAISE EXCEPTION 'route remains blocked'; END IF;
 rid=(j->>'id')::uuid;tok=(j->>'token')::uuid;
 IF NOT public.openwa_check_claimed_intake(rid,tok,true,false) OR public.openwa_check_claimed_intake(rid,gen_random_uuid(),true,false) OR public.openwa_check_claimed_intake(rid,tok,false,false) THEN RAISE EXCEPTION 'preprocess binding check'; END IF;
 -- Real deferred handoff finalizes receipt and clears its ordinary token.
 IF NOT public.defer_openwa_webhook_event(a,c,'intake229','blocked','fixture-native','unmatched_status',NULL,'{"status":"delivered"}',tok) THEN RAISE EXCEPTION 'defer handoff'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.openwa_deferred_events WHERE account_id=a AND connection_id=c AND provider_event_id='blocked' AND intake_canonical_mode=true) THEN RAISE EXCEPTION 'handoff mode lost'; END IF;
 IF public.openwa_finish_signed_intake(rid,gen_random_uuid(),NULL)<>'conflict' THEN RAISE EXCEPTION 'deferred token bypass'; END IF;
 IF public.openwa_finish_signed_intake(rid,tok,NULL)<>'completed' THEN RAISE EXCEPTION 'handoff finish'; END IF;
 IF EXISTS(SELECT 1 FROM public.claim_openwa_deferred_events(10) x WHERE x.account_id=a AND x.connection_id=c) OR EXISTS(SELECT 1 FROM public.claim_openwa_deferred_events_for_mode(false,10) x WHERE x.account_id=a AND x.connection_id=c) THEN RAISE EXCEPTION 'wrong worker claimed pinned handoff'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.claim_openwa_deferred_events_for_mode(true,10) x WHERE x.account_id=a AND x.connection_id=c) THEN RAISE EXCEPTION 'pinned handoff unclaimable'; END IF;
 IF public.openwa_enqueue_signed_intake(a,c,'rotation','intake229',NULL,cv,true,d,cipher)<>'accepted' THEN RAISE EXCEPTION 'rotation fixture'; END IF;
 UPDATE public.whatsapp_connections SET session_id='intake229-rotated' WHERE account_id=a AND id=c;
 IF public.openwa_claim_signed_intake(true)->>'state'<>'review' THEN RAISE EXCEPTION 'credential rotation admitted'; END IF;

 j=public.openwa_intake_review_page(a,u,NULL,20);
 IF jsonb_array_length(j->'rows')<>2 OR j::text LIKE '%ciphertext%' OR j::text LIKE '%processing_token%' THEN RAISE EXCEPTION 'review projection'; END IF;
 j=public.openwa_intake_health(a,u,true);
 IF (j->>'review')::int<>1 OR (j->>'closed_unverified')::int<>1 OR (j->>'completed_24h')::int<>2 OR (j->>'pending')::int<>0 THEN RAISE EXCEPTION 'health %',j; END IF;
 BEGIN PERFORM public.openwa_intake_health(a,other_u,true);RAISE EXCEPTION 'foreign health';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 IF has_function_privilege('authenticated','public.openwa_enqueue_signed_intake(uuid,uuid,text,text,text,timestamptz,boolean,text,text)','EXECUTE') OR has_function_privilege('anon','public.openwa_claim_signed_intake(boolean)','EXECUTE') OR has_table_privilege('authenticated','public.whatsapp_webhook_event_receipts','SELECT') THEN RAISE EXCEPTION 'browser ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
