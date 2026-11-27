BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002331'; a uuid;s uuid; ch uuid; ep uuid; d timestamptz;cv timestamptz;v jsonb;p uuid;conv uuid;can uuid;mid uuid;rid uuid;tok uuid;cl uuid;before_at timestamptz;next_rid uuid; next_tok uuid; stale_id uuid; stale_token uuid; old_at timestamptz; hist_id uuid; hist_token uuid; hist_can uuid; hist_mid uuid; hist_claim uuid;
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
 -- Old workers cannot activate recovery merely because schema was deployed.
 IF public.openwa_claim_signed_intake(true)->>'state'<>'idle' THEN RAISE EXCEPTION 'old worker unexpectedly recovered'; END IF;
 -- New worker with actual service role recovers and claims the untouched next one.
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.openwa_claim_signed_intake_v2(true);
 EXECUTE 'RESET ROLE';
 next_rid=(v->>'id')::uuid;next_tok=(v->>'token')::uuid;
 IF v->>'state'<>'claimed' OR next_rid=rid OR NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=next_rid AND provider_event_id='after-video' AND processing_attempts=1) THEN RAISE EXCEPTION 'queue not recovered %',v; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid AND intake_state='completed' AND intake_recovered_at IS NOT NULL AND intake_recovered_from='processing_uncertain' AND processed_at IS NOT NULL AND intake_ciphertext IS NULL AND processing_attempts=1) OR NOT public.openwa_recover_returned_intake(a,s,rid) THEN RAISE EXCEPTION 'recovery audit'; END IF;
 IF (SELECT count(*) FROM public.inbox_canonical_messages WHERE account_id=a)<>1 OR public.inbox_claim_canonical_effect(a,can,s,'long-video',tok) IS NOT NULL THEN RAISE EXCEPTION 'effect replay'; END IF;
 IF public.openwa_finish_signed_intake(next_rid,next_tok,'processing_uncertain')<>'review' OR public.openwa_recover_returned_intake(a,s,next_rid) OR public.openwa_renew_signed_intake(next_rid,next_tok,true,false) THEN RAISE EXCEPTION 'uncertain event replayed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=next_rid AND intake_state='review' AND intake_ciphertext IS NOT NULL AND processed_at IS NULL) THEN RAISE EXCEPTION 'uncertain evidence lost'; END IF;
 -- Real historical proof after credential rotation: no replay under new credentials.
 IF public.openwa_intake_close_unverified(a,u,next_rid)<>'closed_unverified' THEN RAISE EXCEPTION 'fixture review close'; END IF;
 IF public.openwa_enqueue_signed_intake(a,s,'historical','intake233',NULL,cv,true,repeat('c',64),repeat('c',100))<>'accepted' THEN RAISE EXCEPTION 'historical enqueue'; END IF;
 v=public.openwa_claim_signed_intake(true);hist_id=(v->>'id')::uuid;hist_token=(v->>'token')::uuid;
 v=public.inbox_commit_canonical_inbound_context(a,s,'historical',hist_token,conv,'intake233',NULL,'false_15550000333@c.us_233DEF',true,'text','fixture',NULL,'15550000333@c.us',clock_timestamp(),NULL,'{"chatId":"15550000333@c.us","type":"text","text":"fixture"}',false,false);
 IF v->>'state'<>'inserted' THEN RAISE EXCEPTION 'historical source'; END IF;
 hist_can=(v->>'canonicalId')::uuid;hist_mid=(v->>'messageId')::uuid;
 hist_claim=public.inbox_claim_canonical_effect(a,hist_can,s,'historical',hist_token);
 IF hist_claim IS NULL OR NOT public.inbox_begin_canonical_stage(a,hist_can,hist_claim,'message_received') OR NOT public.inbox_finish_canonical_stage(a,hist_can,hist_claim,'message_received',true) OR NOT public.inbox_finish_canonical_effect(a,hist_can,hist_claim,true) THEN RAISE EXCEPTION 'historical effect'; END IF;
 IF public.openwa_finish_signed_intake(hist_id,hist_token,'processing_uncertain')<>'review' THEN RAISE EXCEPTION 'historical review'; END IF;
 -- This credential change closes the old epoch. Receipt-only recovery must
 -- not authorize new processing under it.
 UPDATE public.whatsapp_connection_credentials SET api_key_encrypted='rotated-fixture' WHERE account_id=a AND connection_id=s RETURNING updated_at INTO cv;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep AND valid_until IS NOT NULL AND NOT is_primary) THEN RAISE EXCEPTION 'credential did not close epoch'; END IF;
 IF public.inbox_validate_canonical_route(a,conv,hist_mid,s) OR public.openwa_returned_intake_evidence(hist_id) IS NULL THEN RAISE EXCEPTION 'historical proof'; END IF;
 EXECUTE 'SET LOCAL ROLE service_role';
 IF NOT public.openwa_recover_returned_intake(a,s,hist_id) THEN RAISE EXCEPTION 'historical receipt recovery'; END IF;
 EXECUTE 'RESET ROLE';
 -- A never-claimed event with stale credentials remains blocked, not rebound.
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_phone,intake_credential_version,processing_attempts)
 VALUES(a,s,'stale-binding',clock_timestamp(),'pending',true,repeat('d',100),repeat('d',64),'intake233','15550000233',cv-interval '1 second',0) RETURNING id INTO stale_id;
 IF public.openwa_claim_signed_intake(true)->>'state'<>'review' OR NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=stale_id AND intake_reason='binding_changed' AND processing_attempts=0 AND intake_ciphertext IS NOT NULL) THEN RAISE EXCEPTION 'stale binding replayed'; END IF;
 IF public.openwa_intake_close_unverified(a,u,stale_id)<>'closed_unverified' THEN RAISE EXCEPTION 'stale fixture close'; END IF;
 -- Seed an expired lease without touching a live row or sleeping 90 seconds.
 stale_token=gen_random_uuid();old_at=clock_timestamp()-interval '91 seconds';
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_phone,intake_credential_version,processing_attempts,processing_token,processing_started_at,intake_claim_token,intake_claimed_at)
 VALUES(a,s,'expired-lease',old_at,'running',true,repeat('e',100),repeat('e',64),'intake233','15550000233',cv,1,stale_token,old_at,stale_token,old_at) RETURNING id INTO stale_id;
 IF public.openwa_renew_signed_intake(stale_id,stale_token,true,false) OR public.openwa_claim_signed_intake(true)->>'state'<>'idle' OR NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=stale_id AND intake_state='review' AND intake_reason='lease_expired' AND intake_ciphertext IS NOT NULL) THEN RAISE EXCEPTION 'expired lease revived'; END IF;
 -- A long-lived renewed lease can still be finalized; the original age
 -- is preserved and the heartbeat cannot extend beyond the hard cap.
 IF public.openwa_intake_close_unverified(a,u,stale_id)<>'closed_unverified' THEN RAISE EXCEPTION 'expired fixture close'; END IF;
 stale_token=gen_random_uuid();old_at=clock_timestamp()-interval '110 seconds';
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_phone,intake_credential_version,processing_attempts,processing_token,processing_started_at,intake_claim_token,intake_claimed_at)
 VALUES(a,s,'renewed-long',old_at,'running',true,repeat('f',100),repeat('f',64),'intake233','15550000233',cv,1,stale_token,clock_timestamp()-interval '5 seconds',stale_token,old_at) RETURNING id INTO stale_id;
 IF NOT public.openwa_renew_signed_intake(stale_id,stale_token,true,false) OR public.openwa_claim_signed_intake_v2(true)->>'state'<>'idle' THEN RAISE EXCEPTION 'long renewed lease lost'; END IF;
 UPDATE public.whatsapp_webhook_event_receipts SET processed_at=clock_timestamp(),processing_started_at=NULL WHERE id=stale_id AND processing_token=stale_token;
 IF public.openwa_finish_signed_intake(stale_id,stale_token,NULL)<>'completed' THEN RAISE EXCEPTION 'long finalization failed'; END IF;
 stale_token=gen_random_uuid();old_at=clock_timestamp()-interval '301 seconds';
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_phone,intake_credential_version,processing_attempts,processing_token,processing_started_at,intake_claim_token,intake_claimed_at)
 VALUES(a,s,'hard-cap',old_at,'running',true,repeat('a',100),repeat('a',64),'intake233','15550000233',cv,1,stale_token,clock_timestamp()-interval '5 seconds',stale_token,old_at) RETURNING id INTO stale_id;
 IF public.openwa_renew_signed_intake(stale_id,stale_token,true,false) THEN RAISE EXCEPTION 'unbounded lease renewal'; END IF;
 IF has_function_privilege('anon','public.openwa_claim_signed_intake_v2(boolean)','EXECUTE') OR has_function_privilege('authenticated','public.openwa_claim_signed_intake_v2(boolean)','EXECUTE') THEN RAISE EXCEPTION 'v2 claim ACL'; END IF;
 IF has_function_privilege('authenticated','public.openwa_renew_signed_intake(uuid,uuid,boolean,boolean)','EXECUTE') OR has_function_privilege('anon','public.openwa_recover_returned_intake(uuid,uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.openwa_returned_intake_evidence(uuid)','EXECUTE') THEN RAISE EXCEPTION 'browser ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
