BEGIN;
DO $fixture$
DECLARE u uuid:='00000000-0000-4000-8000-000000002081'; a uuid; s1 uuid;s2 uuid;s3 uuid;ch uuid;ch2 uuid;ep1 uuid;ep2 uuid;ep3 uuid; d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid; canonical uuid; token uuid; i int; x uuid; session text; nid text; expected text; ev text; n bigint;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox208@example.test','{"full_name":"Inbox 208"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 FOR i IN 1..3 LOOP
  session='inbox208-'||i; 
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready',session,CASE WHEN i=3 THEN '15550000122' ELSE '15550000121' END) RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa',CASE WHEN i=3 THEN '15550000122' ELSE '15550000121' END,session,NULL,d,cv,clock_timestamp(),'fixture-'||i,i<>2);
  IF i=1 THEN s1=x;ch=(v->>'channel_id')::uuid;ep1=(v->>'membership_id')::uuid;
  ELSIF i=2 THEN s2=x;ep2=(v->>'membership_id')::uuid; IF (v->>'channel_id')::uuid<>ch THEN RAISE EXCEPTION 'same channel failed'; END IF;
  ELSE s3=x;ch2=(v->>'channel_id')::uuid;ep3=(v->>'membership_id')::uuid; END IF;
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000281','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 -- Synthetic proof only; never seed actual TEST engine equivalence.
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref)
 VALUES(a,'openwa',ch,s1,ep1,'fixture-shared-v1','synthetic-contract'),(a,'openwa',ch,s2,ep2,'fixture-shared-v1','synthetic-contract'),(a,'openwa',ch2,s3,ep3,'fixture-shared-v1','synthetic-contract');
 FOR i IN 1..5 LOOP
  x=CASE WHEN i=2 THEN s2 WHEN i=3 THEN s3 ELSE s1 END;
  session=CASE WHEN i=2 THEN 'inbox208-2' WHEN i=3 THEN 'inbox208-3' ELSE 'inbox208-1' END;
  nid=CASE WHEN i=4 THEN 'different-native' WHEN i=5 THEN 'event-fallback' ELSE 'same-native' END;
  expected=CASE WHEN i=2 THEN 'duplicate' WHEN i=5 THEN 'review' ELSE 'reserved' END;
  token=gen_random_uuid();ev='inbox208-event-'||i;
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
  VALUES(a,x,'openwa',ev,clock_timestamp(),token,clock_timestamp());
  v=public.inbox_record_canonical_observation(a,x,ev,token,c,session,NULL,nid,i<>5,'inbound','{"type":"text","text":"same body"}');
  IF v->>'state'<>expected THEN RAISE EXCEPTION 'unexpected result %, %',i,v; END IF;
  IF i=1 THEN canonical=(v->>'canonicalId')::uuid;
  ELSIF i=2 AND (v->>'canonicalId')::uuid<>canonical THEN RAISE EXCEPTION 'duplicate canonical mismatch';
  ELSIF i=3 AND (v->>'canonicalId')::uuid=canonical THEN RAISE EXCEPTION 'cross-channel collapse'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.inbox_canonical_messages WHERE account_id=a)<>3
 OR (SELECT count(*) FROM public.inbox_message_connection_observations WHERE account_id=a)<>4
 OR (SELECT count(*) FROM public.inbox_canonical_effects WHERE account_id=a)<>3
 OR (SELECT count(*) FROM public.inbox_canonical_intake_review WHERE account_id=a)<>1
 OR EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=c)
 OR (SELECT unread_count FROM public.conversations WHERE id=c)<>0 THEN RAISE EXCEPTION 'observation/fanout invariant'; END IF;
 BEGIN
  PERFORM public.inbox_record_canonical_observation(a,s1,'inbox208-event-1',gen_random_uuid(),c,'inbox208-1',NULL,'same-native',true,'inbound','{}');
  RAISE EXCEPTION 'forged receipt accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF has_function_privilege('authenticated','public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb)','EXECUTE')
 OR has_table_privilege('authenticated','public.inbox_canonical_intake_review','SELECT')
 OR has_table_privilege('service_role','public.inbox_message_connection_observations','UPDATE') THEN RAISE EXCEPTION 'observation ACL'; END IF;
END $fixture$;
ROLLBACK;
