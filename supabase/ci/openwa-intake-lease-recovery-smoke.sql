BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002331'; a uuid;s uuid; ch uuid; ep uuid; d timestamptz;cv timestamptz;v jsonb;p uuid;conv uuid;can uuid;mid uuid;rid uuid;tok uuid;cl uuid;before_at timestamptz;next_rid uuid; next_tok uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox233@example.test','{"full_name":"Inbox 233"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','intake233','15550000233') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted,webhook_url)
 VALUES(a,s,'openwa','https://fixture.example','fixture','fixture','https://wacrm.example.test/api/whatsapp/openwa/webhook') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_openwa_namespace(a,u,s,'15550000233','intake233',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.32.1');
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000333','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO conv;
 IF public.openwa_enqueue_signed_intake(a,s,'long-video','intake233',NULL,cv,true,repeat('a',64),repeat('a',100))<>'accepted' THEN RAISE EXCEPTION 'enqueue'; END IF;
 v=public.openwa_claim_signed_intake(true);rid=(v->>'id')::uuid;tok=(v->>'token')::uuid;
 SELECT intake_claimed_at INTO STRICT before_at FROM public.whatsapp_webhook_event_receipts WHERE id=rid;
 IF public.openwa_renew_signed_intake(rid,gen_random_uuid(),true,false) OR public.openwa_renew_signed_intake(rid,tok,false,false) THEN RAISE EXCEPTION 'foreign renewal'; END IF;
 PERFORM pg_sleep(0.01);
 EXECUTE 'SET LOCAL ROLE service_role';
 IF NOT public.openwa_renew_signed_intake(rid,tok,true,false) THEN RAISE EXCEPTION 'valid renewal'; END IF;
 EXECUTE 'RESET ROLE';
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid AND intake_claimed_at=before_at AND processing_started_at>before_at AND intake_claim_token=tok AND processing_attempts=1) THEN RAISE EXCEPTION 'claim origin changed'; END IF;
 IF public.openwa_enqueue_signed_intake(a,s,'after-video','intake233',NULL,cv,true,repeat('b',64),repeat('b',100))<>'accepted' OR public.openwa_claim_signed_intake(true)->>'state'<>'idle' THEN RAISE EXCEPTION 'parallel route admitted'; END IF;
 v=public.inbox_commit_canonical_inbound_context(a,s,'long-video',tok,conv,'intake233',NULL,'false_15550000333@c.us_233ABC',true,'video',NULL,'video/mp4','15550000333@c.us',clock_timestamp(),NULL,'{"chatId":"15550000333@c.us","type":"video"}',false,false);
 IF v->>'state'<>'inserted' THEN RAISE EXCEPTION 'source %',v; END IF;
 can=(v->>'canonicalId')::uuid;mid=(v->>'messageId')::uuid;
 cl=public.inbox_claim_canonical_effect(a,can,s,'long-video',tok);
 IF cl IS NULL OR NOT public.inbox_begin_canonical_stage(a,can,cl,'message_received') OR NOT public.inbox_finish_canonical_stage(a,can,cl,'message_received',true) OR NOT public.inbox_finish_canonical_effect(a,can,cl,true) THEN RAISE EXCEPTION 'effect'; END IF;
 IF public.openwa_finish_signed_intake(rid,tok,'processing_uncertain')<>'review' THEN RAISE EXCEPTION 'uncertain receipt'; END IF;
 IF public.openwa_renew_signed_intake(rid,tok,true,false) OR public.openwa_recover_returned_intake(a,s,rid) OR public.openwa_returned_intake_evidence(rid) IS NOT NULL OR public.openwa_claim_signed_intake(true)->>'state'<>'idle' THEN RAISE EXCEPTION 'missing media bypass'; END IF;
 UPDATE public.messages SET media_url='https://fixture.example/video.mp4' WHERE id=mid;
 IF public.openwa_recover_returned_intake(gen_random_uuid(),s,rid) OR public.openwa_recover_returned_intake(a,gen_random_uuid(),rid) THEN RAISE EXCEPTION 'foreign recovery'; END IF;
 IF public.openwa_returned_intake_evidence(rid) IS NULL THEN RAISE EXCEPTION 'completed evidence missing'; END IF;
 -- Claim automatically recovers the first event and claims the untouched next one.
 v=public.openwa_claim_signed_intake(true);next_rid=(v->>'id')::uuid;next_tok=(v->>'token')::uuid;
 IF v->>'state'<>'claimed' OR next_rid=rid OR NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=next_rid AND provider_event_id='after-video' AND processing_attempts=1) THEN RAISE EXCEPTION 'queue not recovered %',v; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid AND intake_state='completed' AND intake_recovered_at IS NOT NULL AND intake_recovered_from='processing_uncertain' AND processed_at IS NOT NULL AND intake_ciphertext IS NULL AND processing_attempts=1) OR NOT public.openwa_recover_returned_intake(a,s,rid) THEN RAISE EXCEPTION 'recovery audit'; END IF;
 IF (SELECT count(*) FROM public.inbox_canonical_messages WHERE account_id=a)<>1 OR public.inbox_claim_canonical_effect(a,can,s,'long-video',tok) IS NOT NULL THEN RAISE EXCEPTION 'effect replay'; END IF;
 IF public.openwa_finish_signed_intake(next_rid,next_tok,'processing_uncertain')<>'review' OR public.openwa_recover_returned_intake(a,s,next_rid) OR public.openwa_renew_signed_intake(next_rid,next_tok,true,false) THEN RAISE EXCEPTION 'uncertain event replayed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=next_rid AND intake_state='review' AND intake_ciphertext IS NOT NULL AND processed_at IS NULL) THEN RAISE EXCEPTION 'uncertain evidence lost'; END IF;
 IF has_function_privilege('authenticated','public.openwa_renew_signed_intake(uuid,uuid,boolean,boolean)','EXECUTE') OR has_function_privilege('anon','public.openwa_recover_returned_intake(uuid,uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.openwa_returned_intake_evidence(uuid)','EXECUTE') THEN RAISE EXCEPTION 'browser ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
