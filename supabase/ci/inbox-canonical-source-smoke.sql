BEGIN;
DO $fixture$
DECLARE u uuid:='00000000-0000-4000-8000-000000002091';a uuid;s1 uuid;s2 uuid;s3 uuid;ch uuid;ch2 uuid;ep1 uuid;ep2 uuid;ep3 uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;canon uuid;m uuid;token uuid;token1 uuid;claim uuid;i int;x uuid;session text;nid text;expected text;ev text;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox209@example.test','{"full_name":"Inbox 209"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 FOR i IN 1..3 LOOP
  session='inbox209-'||i;
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready',session,CASE WHEN i=3 THEN '15550000132' ELSE '15550000131' END) RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa',CASE WHEN i=3 THEN '15550000132' ELSE '15550000131' END,session,NULL,d,cv,clock_timestamp(),'fixture-'||i,i<>2);
  IF i=1 THEN s1=x;ch=(v->>'channel_id')::uuid;ep1=(v->>'membership_id')::uuid;
  ELSIF i=2 THEN s2=x;ep2=(v->>'membership_id')::uuid;
  ELSE s3=x;ch2=(v->>'channel_id')::uuid;ep3=(v->>'membership_id')::uuid; END IF;
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000291','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p,2) RETURNING id INTO c;
 PERFORM public.inbox_capture_legacy_unread(a);
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref)
 VALUES(a,'openwa',ch,s1,ep1,'synthetic-shared','fixture'),(a,'openwa',ch,s2,ep2,'synthetic-shared','fixture'),(a,'openwa',ch2,s3,ep3,'synthetic-shared','fixture');
 FOR i IN 1..4 LOOP
  x=CASE WHEN i=2 THEN s2 WHEN i=3 THEN s3 ELSE s1 END; session=CASE WHEN i=2 THEN 'inbox209-2' WHEN i=3 THEN 'inbox209-3' ELSE 'inbox209-1' END;
  nid=CASE WHEN i=4 THEN 'distinct-native' ELSE 'same-native' END;expected=CASE WHEN i=2 THEN 'duplicate' ELSE 'inserted' END;
  token=gen_random_uuid();ev='inbox209-event-'||i;
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
  VALUES(a,x,'openwa',ev,clock_timestamp(),token,clock_timestamp());
  v=public.inbox_commit_canonical_inbound(a,x,ev,token,c,session,NULL,nid,true,'text','same body',NULL,NULL,clock_timestamp(),NULL,'{"type":"text","text":"same body"}');
  IF v->>'state'<>expected THEN RAISE EXCEPTION 'atomic result mismatch %, %',i,v; END IF;
  IF i=1 THEN canon=(v->>'canonicalId')::uuid;m=(v->>'messageId')::uuid;token1=token;
   IF (v->>'firstInbound')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'first inbound'; END IF;
  ELSIF i=2 THEN
   IF (v->>'messageId')::uuid<>m OR public.inbox_claim_canonical_effect(a,canon,s2,ev,token) IS NOT NULL THEN RAISE EXCEPTION 'secondary dispatched'; END IF;
  ELSIF i=3 THEN
   IF (v->>'canonicalId')::uuid=canon OR (v->>'messageId')::uuid=m THEN RAISE EXCEPTION 'cross-channel alias'; END IF;
  END IF;
 END LOOP;
 claim=public.inbox_claim_canonical_effect(a,canon,s1,'inbox209-event-1',token1);
 IF claim IS NULL OR public.inbox_claim_canonical_effect(a,canon,s1,'inbox209-event-1',token1) IS NOT NULL THEN RAISE EXCEPTION 'claim not single-use'; END IF;
 IF NOT public.inbox_finish_canonical_effect(a,canon,claim,true) OR public.inbox_finish_canonical_effect(a,canon,claim,true) THEN RAISE EXCEPTION 'finish not single-use'; END IF;
 IF (SELECT count(*) FROM public.messages WHERE conversation_id=c)<>3
 OR (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id=a AND evidence_kind='verified_current_ingress')<>3
 OR (SELECT unread_count FROM public.conversations WHERE id=c)<>5
 OR (SELECT sum(unread_count_known) FROM public.inbox_threads WHERE account_id=a)<>3
 OR (SELECT unread_count FROM public.inbox_legacy_unread WHERE account_id=a AND conversation_id=c)<>2
 OR (SELECT count(*) FROM public.inbox_canonical_intake_review WHERE account_id=a AND reason='legacy_collision')<>0
 OR (SELECT count(*) FROM public.messages WHERE conversation_id=c AND provider_message_id='same-native')<>2
 OR (SELECT count(*) FROM public.messages WHERE conversation_id=c AND provider_message_id='same-native' AND message_id IS NULL)<>1
 THEN RAISE EXCEPTION 'atomic unread/source invariant'; END IF;
END $fixture$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
