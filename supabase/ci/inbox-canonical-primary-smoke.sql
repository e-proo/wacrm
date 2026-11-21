BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002111'; a uuid;pri uuid;sec uuid;x uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;canon uuid;token uuid;primary_token uuid;secondary_token uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox211@example.test','{"full_name":"Inbox 211"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 FOR i IN 1..2 LOOP
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox211-'||i,'15550000151') RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa','15550000151','inbox211-'||i,NULL,d,cv,clock_timestamp(),'fixture-'||i,i=1);
  ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
  INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,x,ep,'fixture-namespace','fixture');
  IF i=1 THEN pri=x;ELSE sec=x;END IF;
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000211','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 secondary_token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,sec,'openwa','secondary-first',clock_timestamp(),secondary_token,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,sec,'secondary-first',secondary_token,c,'inbox211-2',NULL,'native',true,'text','body',NULL,NULL,clock_timestamp(),NULL,'{"text":"body"}',true,true);
 IF v->>'state'<>'review' OR v->>'reason'<>'source_unconfirmed' THEN RAISE EXCEPTION 'secondary-first should wait: %',v; END IF;
 canon=(v->>'canonicalId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_messages WHERE id=canon AND origin_connection_id=pri AND source_message_id IS NULL)
 OR EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=c)
 OR public.inbox_claim_canonical_effect(a,canon,sec,'secondary-first',secondary_token) IS NOT NULL THEN RAISE EXCEPTION 'secondary claimed source/effect'; END IF;
 primary_token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,pri,'openwa','primary-later',clock_timestamp(),primary_token,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,pri,'primary-later',primary_token,c,'inbox211-1',NULL,'native',true,'text','body',NULL,NULL,clock_timestamp(),NULL,'{"text":"body"}',false,false);
 IF v->>'state'<>'inserted' OR (v->>'canonicalId')::uuid<>canon OR (v->'dispatchContext'->>'contactCreated')::boolean IS DISTINCT FROM true
 OR (v->'dispatchContext'->>'conversationCreated')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'primary context recovery %',v; END IF;
 IF (SELECT count(*) FROM public.inbox_message_connection_observations WHERE canonical_id=canon)<>2
 OR (SELECT count(*) FROM public.messages WHERE conversation_id=c)<>1 OR (SELECT unread_count FROM public.conversations WHERE id=c)<>1
 OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review WHERE account_id=a AND connection_id=sec AND reason='source_unconfirmed' AND resolved_at IS NOT NULL)
 THEN RAISE EXCEPTION 'primary observation invariant'; END IF;
 token=public.inbox_claim_canonical_effect(a,canon,pri,'primary-later',primary_token);
 IF token IS NULL OR public.inbox_claim_canonical_effect(a,canon,sec,'secondary-first',secondary_token) IS NOT NULL THEN RAISE EXCEPTION 'claim wrong route'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
