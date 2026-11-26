BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002241'; other_u uuid:='00000000-0000-4000-8000-000000002242';
 a uuid; c uuid; c2 uuid; ep uuid; ch uuid; cv timestamptz; d timestamptz; v jsonb; old_proof_at timestamptz; d2 timestamptz; cv2 timestamptz;
 contact uuid; conv uuid; tok uuid; native text:='false_15550000224@c.us_3EB0ABCD';
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox224@example.test','{"full_name":"Inbox 224"}'),(other_u,'inbox224other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox224-a','15550000124') RETURNING id,updated_at INTO c,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted,webhook_url)
 VALUES(a,c,'openwa','https://example.test','fixture','fixture-secret','https://wacrm.example.test/api/whatsapp/openwa/webhook') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,c,'openwa','15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),'identity-only',false);
 IF EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs WHERE account_id=a) THEN RAISE EXCEPTION 'identity alone seeded proof'; END IF;
 BEGIN
  PERFORM public.inbox_enroll_verified_openwa_namespace(a,other_u,c,'15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
  RAISE EXCEPTION 'foreign actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'baileys','0.29.1');
  RAISE EXCEPTION 'unreviewed engine accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.30.0');
  RAISE EXCEPTION 'unreviewed version accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000124','inbox224-a',NULL,d,cv-interval '1 second',clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
  RAISE EXCEPTION 'stale credential accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 v=public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
 ep=(v->>'membership_id')::uuid; ch=(v->>'channel_id')::uuid;
 IF v->>'namespace_verified'<>'true' OR v->>'primary'<>'true'
 OR (SELECT engine FROM public.whatsapp_connections WHERE id=c)<>'whatsapp-web.js'
 OR (SELECT count(*) FROM public.inbox_native_namespace_proofs WHERE account_id=a AND scope_kind='single_connection' AND verified_by=u)<>1
 OR (SELECT count(*) FROM public.whatsapp_channel_memberships WHERE account_id=a AND valid_until IS NULL AND is_primary)<>1
 THEN RAISE EXCEPTION 'proof not atomic %',v; END IF;
 SELECT verified_at INTO STRICT old_proof_at FROM public.inbox_native_namespace_proofs WHERE membership_id=ep;
 SELECT updated_at INTO STRICT d FROM public.whatsapp_connections WHERE id=c;
 v=public.inbox_enroll_verified_openwa_namespace(a,u,c,'15550000124','inbox224-a',NULL,d,cv,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
 IF (v->>'membership_id')::uuid<>ep OR (SELECT verified_at FROM public.inbox_native_namespace_proofs WHERE membership_id=ep)<>old_proof_at THEN RAISE EXCEPTION 'repeat changed immutable proof'; END IF;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox224-b','15550000124') RETURNING id,updated_at INTO c2,d2;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted,webhook_url)
 VALUES(a,c2,'openwa','https://example.test','fixture','fixture-secret','https://wacrm.example.test/api/whatsapp/openwa/webhook') RETURNING updated_at INTO cv2;
 BEGIN
  PERFORM public.inbox_enroll_verified_openwa_namespace(a,u,c2,'15550000124','inbox224-b',NULL,d2,cv2,clock_timestamp(),gen_random_uuid(),'whatsapp-web.js','0.29.1');
  RAISE EXCEPTION 'unproven second connection promoted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM public.inbox_native_namespace_proofs WHERE account_id=a)<>1 OR NOT EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep AND is_primary AND valid_until IS NULL)
 OR EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE connection_id=c2 AND valid_until IS NULL)
 THEN RAISE EXCEPTION 'handover conflict changed state'; END IF;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000224','Fixture') RETURNING id INTO contact;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,contact) RETURNING id INTO conv;
 tok=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,c,'openwa','bad-peer',clock_timestamp(),tok,clock_timestamp());
 v=public.inbox_record_canonical_observation(a,c,'bad-peer',tok,conv,'inbox224-a',NULL,native,true,'inbound','{"chatId":"15550000999@c.us"}');
 IF v->>'reason'<>'peer_conflict' THEN RAISE EXCEPTION 'peer conflict admitted %',v; END IF;
 tok=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,c,'openwa','good-peer',clock_timestamp(),tok,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,c,'good-peer',tok,conv,'inbox224-a',NULL,native,true,'text','fixture',NULL,'15550000224@c.us',clock_timestamp(),NULL,'{"chatId":"15550000224@c.us","text":"fixture"}',false,false);
 IF v->>'state'<>'inserted' OR (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id=a)<>1 THEN RAISE EXCEPTION 'fresh canonical source missing %',v; END IF;
 IF (public.inbox_active_observation_epoch(a,c,'inbox224-a',NULL,old_proof_at-interval '1 microsecond')).id IS NOT NULL THEN RAISE EXCEPTION 'retrospective proof accepted'; END IF;
 UPDATE public.whatsapp_connections SET engine='baileys' WHERE id=c AND account_id=a;
 IF EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep AND valid_until IS NULL) THEN RAISE EXCEPTION 'engine change did not invalidate epoch'; END IF;
 IF (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id=a)<>1 THEN RAISE EXCEPTION 'engine change moved history'; END IF;
 IF has_function_privilege('authenticated','public.inbox_enroll_verified_openwa_namespace(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,uuid,text,text)','EXECUTE') OR has_function_privilege('anon','public.inbox_enroll_verified_openwa_namespace(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,uuid,text,text)','EXECUTE') OR has_table_privilege('authenticated','public.inbox_native_namespace_proofs','INSERT') THEN RAISE EXCEPTION 'browser proof privilege'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
