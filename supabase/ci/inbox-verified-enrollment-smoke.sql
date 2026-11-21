BEGIN;
DO $fixture$
DECLARE u uuid:='00000000-0000-4000-8000-000000002061'; a uuid; ca uuid; s1 uuid; s2 uuid; ep1 uuid; ep2 uuid; c uuid; p uuid; m uuid; m2 uuid; v jsonb; d timestamptz; cv timestamptz; n int;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox206@example.test','{"full_name":"Inbox 206"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox206-a','15550000111') RETURNING id,updated_at INTO s1,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s1,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s1,'openwa','15550000111','inbox206-a',NULL,d,cv,clock_timestamp(),'fixture-one',true);
 ca=(v->>'channel_id')::uuid; ep1=(v->>'membership_id')::uuid;
 v=public.inbox_enroll_verified_channel(a,u,s1,'openwa','15550000111','inbox206-a',NULL,d,cv,clock_timestamp(),'fixture-retry',false);
 IF (v->>'membership_id')::uuid<>ep1 THEN RAISE EXCEPTION 'repeat created new epoch'; END IF;
 BEGIN
  PERFORM public.inbox_enroll_verified_channel(a,u,s1,'openwa','15550000999','inbox206-a',NULL,d,cv,clock_timestamp(),'wrong-phone',false);
  RAISE EXCEPTION 'wrong phone accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox206-b','15550000111') RETURNING id,updated_at INTO s2,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s2,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s2,'openwa','15550000111','inbox206-b',NULL,d,cv,clock_timestamp(),'fixture-two',false);
 ep2=(v->>'membership_id')::uuid;
 IF (v->>'channel_id')::uuid<>ca OR ep2=ep1 THEN RAISE EXCEPTION 'same number channel grouping invalid'; END IF;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000200','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p,2) RETURNING id INTO c;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
 VALUES(c,'customer','text','fixture','delivered','openwa',s1,'inbox206-native-a','inbox206-native-a',clock_timestamp()) RETURNING id INTO m;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
 VALUES(c,'customer','text','fixture','delivered','openwa',s2,'inbox206-native-b','inbox206-native-b',clock_timestamp()) RETURNING id INTO m2;
 IF public.inbox_backfill_verified_messages(a,100)<>0 THEN RAISE EXCEPTION 'unproven history assigned'; END IF;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(m,a,c,'openwa',ca,s1,ep1,'inbox206-native-a',clock_timestamp(),'synthetic-proof-a'),
       (m2,a,c,'openwa',ca,s2,ep2,'inbox206-native-b',clock_timestamp(),'synthetic-proof-b');
 IF public.inbox_backfill_verified_messages(a,1)<>1 OR public.inbox_backfill_verified_messages(a,1)<>1 OR public.inbox_backfill_verified_messages(a,1)<>0 THEN
  RAISE EXCEPTION 'backfill not bounded/idempotent'; END IF;
 IF (SELECT count(*) FROM public.inbox_threads WHERE account_id=a)<>1
   OR (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id=a)<>2
   OR EXISTS(SELECT 1 FROM public.inbox_threads WHERE account_id=a AND (unread_count_known<>0 OR last_trusted_inbound_at IS NOT NULL OR ingest_highwater<>2))
 THEN RAISE EXCEPTION 'projection mismatch or historical trust leak'; END IF;
 IF public.inbox_capture_legacy_unread(a)<>1 OR public.inbox_capture_legacy_unread(a)<>0
   OR (SELECT unread_count FROM public.conversations WHERE id=c)<>2 THEN RAISE EXCEPTION 'legacy unread altered'; END IF;
 UPDATE public.whatsapp_connection_credentials SET api_key_encrypted='fixture-rotated' WHERE connection_id=s1;
 IF EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep1 AND valid_until IS NULL) THEN RAISE EXCEPTION 'credential rotation did not close epoch'; END IF;
 UPDATE public.whatsapp_connections SET phone_identity='15550000999' WHERE id=s2;
 IF EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE id=ep2 AND valid_until IS NULL) THEN RAISE EXCEPTION 're-pair did not close epoch'; END IF;
 IF (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id=a AND channel_id=ca)<>2 THEN RAISE EXCEPTION 'history moved'; END IF;
 IF has_table_privilege('authenticated','public.inbox_verified_message_evidence','SELECT') OR has_function_privilege('authenticated','public.inbox_backfill_verified_messages(uuid,integer)','EXECUTE') OR has_function_privilege('anon','public.inbox_enroll_verified_channel(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,boolean)','EXECUTE') THEN
 RAISE EXCEPTION 'browser evidence privilege'; END IF;
END $fixture$;
ROLLBACK;
