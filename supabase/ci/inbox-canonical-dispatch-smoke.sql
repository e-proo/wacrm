BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002101'; a uuid;s uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;canon uuid;m uuid;token uuid;claim uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox210@example.test','{"full_name":"Inbox 210"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox210','15550000141') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000141','inbox210',NULL,d,cv,clock_timestamp(),'fixture',true);
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000201','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,s,ep,'fixture-namespace','fixture');
 token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','inbox210-event',clock_timestamp(),token,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,s,'inbox210-event',token,c,'inbox210',NULL,'native',true,'text','body',NULL,NULL,clock_timestamp(),NULL,'{"text":"body"}',true,true);
 IF v->>'state'<>'inserted' OR (v->'dispatchContext'->>'contactCreated')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'dispatch context'; END IF;
 canon=(v->>'canonicalId')::uuid;m=(v->>'messageId')::uuid;
 v=public.inbox_commit_canonical_inbound_context(a,s,'inbox210-event',token,c,'inbox210',NULL,'native',true,'text','body',NULL,NULL,clock_timestamp(),NULL,'{"text":"body"}',false,false);
 IF v->>'state'<>'duplicate' OR (v->>'canClaim')::boolean IS DISTINCT FROM true OR (v->'dispatchContext'->>'contactCreated')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'pending recovery'; END IF;
 claim=public.inbox_claim_canonical_effect(a,canon,s,'inbox210-event',token);
 IF claim IS NULL THEN RAISE EXCEPTION 'claim missing'; END IF;
 BEGIN
  UPDATE public.inbox_canonical_effects SET state='pending',claim_token=NULL,claimed_at=NULL WHERE canonical_id=canon;
  RAISE EXCEPTION 'claimed effect reset accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 DELETE FROM public.messages WHERE id=m;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_messages WHERE id=canon AND source_message_id IS NULL) OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effects WHERE canonical_id=canon AND state='review') THEN RAISE EXCEPTION 'source tombstone'; END IF;
 IF public.inbox_claim_canonical_effect(a,canon,s,'inbox210-event',token) IS NOT NULL THEN RAISE EXCEPTION 'deleted source dispatched'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
