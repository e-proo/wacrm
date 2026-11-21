BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002141';a uuid;x uuid;pri uuid;sec uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;token uuid;mid uuid;str text;outcome text;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox214@example.test','{"full_name":"Inbox 214"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 FOR i IN 1..2 LOOP
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox214-'||i,'15550000171') RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa','15550000171','inbox214-'||i,NULL,d,cv,clock_timestamp(),'fixture-'||i,i=1);
  ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
  INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,x,ep,'fixture-shared','fixture');
  IF i=1 THEN pri=x;ELSE sec=x;END IF;
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000214','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p,2) RETURNING id INTO c;
 FOR i IN 1..3 LOOP
  x=CASE WHEN i=2 THEN pri ELSE sec END;token=gen_random_uuid();str='inbox214-echo-'||i;
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,x,'openwa',str,clock_timestamp(),token,clock_timestamp());
  v=public.inbox_commit_outbound_echo(a,x,str,token,CASE WHEN i=2 THEN 'inbox214-1' ELSE 'inbox214-2' END,NULL,c,'native-echo',true,'15550000214@c.us','15550000214','text','body',NULL,clock_timestamp(),'{}');
  IF v->>'state'<>(CASE WHEN i=1 THEN 'review' WHEN i=2 THEN 'inserted' ELSE 'existing' END) THEN RAISE EXCEPTION 'echo state %',v; END IF;
  IF i=2 THEN mid=(v->>'messageId')::uuid;ELSIF i=3 AND (v->>'messageId')::uuid<>mid THEN RAISE EXCEPTION 'echo duplicate'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.messages WHERE conversation_id=c)<>1 OR (SELECT unread_count FROM public.conversations WHERE id=c)<>2 OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effects WHERE account_id=a AND state='not_applicable') THEN RAISE EXCEPTION 'echo source/side effect invariant'; END IF;
 token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,sec,'openwa','inbox214-ack',clock_timestamp(),token,clock_timestamp());
 outcome=public.inbox_apply_canonical_ack(a,sec,'inbox214-ack',token,'inbox214-2',NULL,'native-echo','read',NULL);
 IF outcome<>'updated' THEN RAISE EXCEPTION 'secondary ACK outcome %',outcome; END IF;
 IF (SELECT status FROM public.messages WHERE id=mid)<>'read' THEN RAISE EXCEPTION 'secondary ACK source status'; END IF;
 IF public.inbox_apply_canonical_ack(a,sec,'inbox214-ack',token,'inbox214-2',NULL,'native-echo','read',NULL)<>'ignored' THEN RAISE EXCEPTION 'ACK replay'; END IF;
 token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,pri,'openwa','inbox214-old-ack',clock_timestamp(),token,clock_timestamp());
 outcome=public.inbox_apply_canonical_ack(a,pri,'inbox214-old-ack',token,'inbox214-1',NULL,'native-echo','delivered',NULL);
 IF outcome<>'ignored' OR (SELECT status FROM public.messages WHERE id=mid)<>'read' THEN RAISE EXCEPTION 'ACK regression'; END IF;
 IF has_table_privilege('authenticated','public.inbox_canonical_ack_observations','SELECT') THEN RAISE EXCEPTION 'ACK browser exposure'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
