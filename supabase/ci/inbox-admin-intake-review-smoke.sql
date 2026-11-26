BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002261'; other_u uuid:='00000000-0000-4000-8000-000000002262';
 a uuid; s uuid; c uuid; contact uuid; ep uuid; ch uuid; d timestamptz; cv timestamptz; v jsonb; can uuid; mid uuid; rt uuid; rid uuid; missing uuid; busy uuid; dup uuid; req uuid; proof_at timestamptz; payload jsonb; native text:='false_15550000226@c.us_3EB0ABCD';
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox226@example.test','{"full_name":"Inbox 226"}'),(other_u,'inbox226other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','fixture-private-session','15550000126') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted,webhook_url)
 VALUES(a,s,'openwa','https://fixture-secret.example','fixture-private-key','fixture-private-signature','https://wacrm.example.test/api/whatsapp/openwa/webhook') RETURNING updated_at INTO cv;
 -- Finalized receipt with retained token (the real webhook contract), no proof.
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processed_at,processing_token)
 VALUES(a,s,'openwa','missing-proof',clock_timestamp(),clock_timestamp(),gen_random_uuid()) RETURNING id INTO missing;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
 VALUES(missing,a,s,'openwa','namespace_unverified',jsonb_build_object('identityKind','native','nativeId',native,'from','15550000226','chatId','15550000226@c.us','type','text','text','held fixture'));
 v=public.inbox_enroll_verified_openwa_namespace(a,u,s,'15550000126','fixture-private-session',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 IF public.inbox_review_decision(a,missing)<>'unverified' THEN RAISE EXCEPTION 'later proof retroactively authorized'; END IF;
 BEGIN PERFORM public.inbox_admin_intake_review_page(a,other_u,false,NULL,20); RAISE EXCEPTION 'foreign actor read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.profiles SET account_role='agent' WHERE user_id=u;
 BEGIN PERFORM public.inbox_admin_settle_intake_review(a,u,missing,'close_unverified',gen_random_uuid()); RAISE EXCEPTION 'agent settlement'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.profiles SET account_role='owner' WHERE user_id=u;
 v=public.inbox_admin_settle_intake_review(a,u,missing,'restore',gen_random_uuid());IF v->>'state'<>'not_eligible' THEN RAISE EXCEPTION 'unproven restore'; END IF;
 req=gen_random_uuid();
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_admin_settle_intake_review(a,u,missing,'close_unverified',req);
 EXECUTE 'RESET ROLE';
 IF v->>'outcome'<>'closed_unverified' OR (SELECT normalized_payload->>'text' FROM public.inbox_canonical_intake_review WHERE receipt_id=missing)<>'held fixture' THEN RAISE EXCEPTION 'close lost evidence'; END IF;
 v=public.inbox_admin_settle_intake_review(a,u,missing,'close_unverified',req);IF v->>'state'<>'settled' THEN RAISE EXCEPTION 'same request not idempotent'; END IF;
 v=public.inbox_admin_settle_intake_review(a,u,missing,'close_unverified',gen_random_uuid());IF v->>'state'<>'conflict' THEN RAISE EXCEPTION 'second decision accepted'; END IF;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','busy',clock_timestamp(),gen_random_uuid(),clock_timestamp()) RETURNING id INTO busy;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload) VALUES(busy,a,s,'openwa','namespace_unverified','{}');
 v=public.inbox_admin_settle_intake_review(a,u,busy,'close_unverified',gen_random_uuid());IF v->>'state'<>'busy' THEN RAISE EXCEPTION 'processing receipt settled'; END IF;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000226','Fixture') RETURNING id INTO contact;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,contact) RETURNING id INTO c;
 -- A proven origin observation with no persisted source; synthesize the
 -- source_unconfirmed recovery boundary through the real reservation RPC.
 SELECT verified_at INTO proof_at FROM public.inbox_native_namespace_proofs WHERE membership_id=ep;
 payload=jsonb_build_object('identityKind','native','nativeId',native,'from','15550000226','chatId','15550000226@c.us','type','text','text','restore fixture','timestamp',ceil(extract(epoch from clock_timestamp()))::bigint);
 rt=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','restore',clock_timestamp(),rt,clock_timestamp()) RETURNING id INTO rid;
 v=public.inbox_record_canonical_observation(a,s,'restore',rt,c,'fixture-private-session',NULL,native,true,'inbound',payload);
 IF v->>'state'<>'reserved' THEN RAISE EXCEPTION 'reservation fixture %',v; END IF;
 can=(v->>'canonicalId')::uuid;
 PERFORM public.inbox_hold_signed_observation(a,s,'restore',rt,'fixture-private-session',NULL,'source_unconfirmed',payload);
 UPDATE public.whatsapp_webhook_event_receipts SET processed_at=clock_timestamp(),processing_started_at=NULL WHERE id=rid;
 IF public.inbox_review_decision(a,rid)<>'restore' THEN RAISE EXCEPTION 'restore proof unavailable %',public.inbox_review_decision(a,rid); END IF;
 -- Never settle a pending or claimed canonical effect. Nested exception rolls
 -- back the synthetic state change before continuing the real restore test.
 BEGIN
  UPDATE public.inbox_canonical_effects SET state='pending' WHERE canonical_id=can AND account_id=a;
  IF public.inbox_review_decision(a,rid)<>'busy' THEN RAISE EXCEPTION 'pending effect eligible'; END IF;
  v=public.inbox_admin_settle_intake_review(a,u,rid,'close_unverified',gen_random_uuid());
  IF v->>'state'<>'busy' THEN RAISE EXCEPTION 'pending effect settled'; END IF;
  RAISE SQLSTATE 'P0002';
 EXCEPTION WHEN no_data_found THEN NULL; END;
 BEGIN
  UPDATE public.inbox_canonical_effects SET state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp() WHERE canonical_id=can AND account_id=a;
  IF public.inbox_review_decision(a,rid)<>'busy' THEN RAISE EXCEPTION 'claimed effect eligible'; END IF;
  v=public.inbox_admin_settle_intake_review(a,u,rid,'restore',gen_random_uuid());
  IF v->>'state'<>'busy' THEN RAISE EXCEPTION 'claimed effect restored'; END IF;
  RAISE SQLSTATE 'P0002';
 EXCEPTION WHEN no_data_found THEN NULL; END;

 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_admin_settle_intake_review(a,u,rid,'restore',gen_random_uuid());
 EXECUTE 'RESET ROLE';
 IF v->>'outcome'<>'restored_history' THEN RAISE EXCEPTION 'restore failed %',v; END IF;
 SELECT source_message_id INTO STRICT mid FROM public.inbox_canonical_messages WHERE id=can;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE account_id=a AND message_id=mid AND evidence_kind='verified_historical_epoch' AND read_before_move)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effects WHERE canonical_id=can AND state='not_applicable' AND claim_token IS NULL)
 OR EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages WHERE canonical_id=can)
 OR EXISTS(SELECT 1 FROM public.inbox_threads WHERE account_id=a AND (unread_count_known<>0 OR last_trusted_inbound_at IS NOT NULL))
 OR coalesce((SELECT unread_count FROM public.conversations WHERE id=c),0)<>0
 OR public.inbox_validate_canonical_route(a,c,mid,s) THEN RAISE EXCEPTION 'restoration opened live effects'; END IF;
 -- Exact later observation of the same canonical source, not a new message.
 rt=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','duplicate',clock_timestamp(),rt,clock_timestamp()) RETURNING id INTO dup;
 v=public.inbox_record_canonical_observation(a,s,'duplicate',rt,c,'fixture-private-session',NULL,native,true,'inbound',payload);
 IF v->>'state'<>'duplicate' THEN RAISE EXCEPTION 'duplicate fixture %',v; END IF;
 PERFORM public.inbox_hold_signed_observation(a,s,'duplicate',rt,'fixture-private-session',NULL,'source_unconfirmed',payload);
 UPDATE public.whatsapp_webhook_event_receipts SET processed_at=clock_timestamp(),processing_started_at=NULL WHERE id=dup;
 v=public.inbox_admin_settle_intake_review(a,u,dup,'duplicate',gen_random_uuid());
 IF v->>'outcome'<>'duplicate_confirmed' OR (SELECT count(*) FROM public.messages WHERE conversation_id=c)<>1 THEN RAISE EXCEPTION 'duplicate not settled %',v; END IF;
 -- Exact native ID with a recorded payload conflict is not settled as duplicate.
 rt=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','payload-conflict',clock_timestamp(),rt,clock_timestamp()) RETURNING id INTO dup;
 payload=payload||jsonb_build_object('text','changed fixture');
 v=public.inbox_record_canonical_observation(a,s,'payload-conflict',rt,c,'fixture-private-session',NULL,native,true,'inbound',payload);
 IF v->>'state'<>'duplicate' THEN RAISE EXCEPTION 'conflict observation fixture'; END IF;
 PERFORM public.inbox_hold_signed_observation(a,s,'payload-conflict',rt,'fixture-private-session',NULL,'payload_changed',payload);
 UPDATE public.whatsapp_webhook_event_receipts SET processed_at=clock_timestamp(),processing_started_at=NULL WHERE id=dup;
 IF public.inbox_review_decision(a,dup)<>'unverified' THEN RAISE EXCEPTION 'payload conflict treated as duplicate'; END IF;
 v=public.inbox_admin_settle_intake_review(a,u,dup,'duplicate',gen_random_uuid());
 IF v->>'state'<>'not_eligible' THEN RAISE EXCEPTION 'payload conflict incorrectly settled'; END IF;
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_admin_intake_review_page(a,u,true,NULL,20);
 EXECUTE 'RESET ROLE';

 IF jsonb_array_length(v->'rows')<>3 OR v::text LIKE '%fixture-private%' OR v::text LIKE '%15550000226%' OR v::text LIKE '%3EB0ABCD%' THEN RAISE EXCEPTION 'review scope/redaction'; END IF;
 IF has_table_privilege('authenticated','public.inbox_intake_review_settlements','SELECT') OR has_table_privilege('service_role','public.inbox_intake_review_settlements','UPDATE')
 OR has_function_privilege('anon','public.inbox_admin_settle_intake_review(uuid,uuid,uuid,text,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.inbox_admin_intake_review_page(uuid,uuid,boolean,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'review ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
