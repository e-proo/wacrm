BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002171';u2 uuid:='00000000-0000-4000-8000-000000002172';a uuid;a2 uuid;pri uuid;sec uuid;x uuid;ch uuid;ch2 uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;p2 uuid;c2 uuid;token uuid;mid uuid;t uuid;t2 uuid;raw uuid;anchor uuid;at timestamptz;arr jsonb;z jsonb;scope text;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox217@example.test','{"full_name":"Inbox 217"}'),(u2,'inbox217-foreign@example.test','{"full_name":"Foreign"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 SELECT account_id INTO STRICT a2 FROM public.profiles WHERE user_id=u2;
 FOR i IN 1..3 LOOP
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity,display_name,provider_metadata) VALUES(a,'openwa','ready','inbox217-'||i,CASE WHEN i<3 THEN '15550000191' ELSE '15550000192' END,'Session '||i,'{"secret":"never-return"}') RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa',CASE WHEN i<3 THEN '15550000191' ELSE '15550000192' END,'inbox217-'||i,NULL,d,cv,clock_timestamp(),'fixture-'||i,i<>2);
  ep=(v->>'membership_id')::uuid;
  INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',(v->>'channel_id')::uuid,x,ep,'fixture-shared','fixture');
  IF i=1 THEN pri=x;ch=(v->>'channel_id')::uuid;ELSIF i=2 THEN sec=x;ELSE ch2=(v->>'channel_id')::uuid;END IF;
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000217','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p,2) RETURNING id INTO c;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u2,a2,'+15550000218','Foreign') RETURNING id INTO p2;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u2,a2,p2) RETURNING id INTO c2;
 at=clock_timestamp();
 FOR i IN 1..3 LOOP
  token=gen_random_uuid();
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,CASE WHEN i=1 THEN pri WHEN i=2 THEN sec ELSE x END,'openwa','read217-'||i,clock_timestamp(),token,clock_timestamp());
  v=public.inbox_commit_canonical_inbound_context(a,CASE WHEN i=1 THEN pri WHEN i=2 THEN sec ELSE x END,'read217-'||i,token,c,'inbox217-'||i,NULL,'native217',true,'text','body',NULL,'15550000217@c.us',at,NULL,'{}',false,false);
  IF i<>2 AND v->>'state'<>'inserted' THEN RAISE EXCEPTION 'fixture %',v; END IF;
 END LOOP;
 SELECT id INTO STRICT t FROM public.inbox_threads WHERE account_id=a AND channel_id=ch AND conversation_id=c;
 SELECT id INTO STRICT t2 FROM public.inbox_threads WHERE account_id=a AND channel_id=ch2 AND conversation_id=c;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,provider,connection_id,provider_message_id,created_at,media_url,reply_to_message_id)
 VALUES(c,'customer','text','unknown','openwa',pri,'unknown217',at,'https://evil.test/?token=secret',(SELECT last_message_id FROM public.inbox_threads WHERE id=t)) RETURNING id INTO raw;
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_read_page(a,u,'channels','active',NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 OR (v::text LIKE '%never-return%') THEN RAISE EXCEPTION 'catalog bound or secret %',v; END IF;
 v=public.inbox_read_page(a,u,'threads','active',NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 THEN RAISE EXCEPTION 'channel threads %',v; END IF;
 anchor=(v->'rows'->0->>'row_id')::uuid;at=(v->'rows'->0->>'sort_at')::timestamptz;
 z=public.inbox_read_page(a,u,'threads','active',NULL,NULL,NULL,NULL,NULL,NULL,1,at,anchor);
 IF jsonb_array_length(z->'rows')<>1 OR (z->'rows'->0->>'row_id')::uuid=anchor THEN RAISE EXCEPTION 'keyset duplicate'; END IF;
 v=public.inbox_read_page(a,u,'history','active',ch,NULL,t,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v::text LIKE '%native217%' OR v::text LIKE '%provider_chat_id%' THEN RAISE EXCEPTION 'history dedup/native secret %',v; END IF;
 mid=(v->'rows'->0->'payload'->>'id')::uuid;
 v=public.inbox_read_page(a,u,'observations','active',ch,NULL,t,NULL,NULL,NULL,10,NULL,NULL,mid);
 IF jsonb_array_length(v->'rows')<>2 OR v::text LIKE '%native217%' OR v::text LIKE '%read217-%' THEN RAISE EXCEPTION 'observations diagnostic scope'; END IF;
 IF public.inbox_read_page(a,u,'observations','active',ch,NULL,t,NULL,NULL,NULL,10,NULL,NULL,raw) IS NOT NULL THEN RAISE EXCEPTION 'foreign scoped observation'; END IF;
 v=public.inbox_read_page(a,u,'resolve','all',NULL,c,NULL,sec,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v->'rows'->0->'payload'->>'channel_id'<>ch::text THEN RAISE EXCEPTION 'same-channel secondary legacy resolution %',v; END IF;
 v=public.inbox_read_page(a,u,'connections','active',ch,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows') r WHERE r->'payload'->>'ready'<>'true') THEN RAISE EXCEPTION 'connection readiness %',v; END IF;
 IF public.inbox_read_page(a,u,'history','active',ch2,NULL,t,NULL,NULL,NULL,10,NULL,NULL) IS NOT NULL THEN RAISE EXCEPTION 'cross channel history'; END IF;
 v=public.inbox_read_page(a,u,'history','unknown',NULL,c,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v->'rows'->0->'payload'->>'id'<>raw::text OR v->'rows'->0->'payload'->>'reply_to_message_id' IS NOT NULL OR v->'rows'->0->'payload'->>'media_url' IS NOT NULL THEN RAISE EXCEPTION 'unknown or unsafe media/reply %',v; END IF;
 v=public.inbox_read_page(a,u,'counts','all',NULL,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF (v->'counts'->>'source_messages')::int<>3 OR (v->'counts'->>'associated_messages')::int<>2 OR (v->'counts'->>'unresolved_messages')::int<>1 OR (v->'counts'->>'known_unread')::int<>2 THEN RAISE EXCEPTION 'counts conservation %',v; END IF;
 v=public.inbox_read_page(a,u,'resolve','all',NULL,c,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>3 THEN RAISE EXCEPTION 'ambiguous deep link %',v; END IF;
 IF public.inbox_read_page(a,u,'resolve','all',NULL,c2,NULL,NULL,NULL,NULL,10,NULL,NULL) IS NOT NULL THEN RAISE EXCEPTION 'foreign parent'; END IF;
 BEGIN PERFORM public.inbox_read_page(a,u2,'threads','active',NULL,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);RAISE EXCEPTION 'foreign actor'; EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 IF has_function_privilege('authenticated','public.inbox_read_page(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,integer,timestamptz,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'browser RPC'; END IF;
 EXECUTE 'RESET ROLE';
 UPDATE public.whatsapp_connections SET status='disconnected' WHERE id IN(pri,sec);
 v=public.inbox_read_page(a,u,'history','historical',ch,NULL,t,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 THEN RAISE EXCEPTION 'historical history lost'; END IF;
 v=public.inbox_read_page(a,u,'connections','historical',ch,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows') r WHERE r->'payload'->>'ready'<>'false') THEN RAISE EXCEPTION 'historical connections %',v; END IF;
 IF public.inbox_read_page(a,u,'history','active',ch,NULL,t,NULL,NULL,NULL,10,NULL,NULL) IS NOT NULL THEN RAISE EXCEPTION 'stale active scope'; END IF;
END $test$;

-- Mixed provider, outbound-only history, unverified registry, null timestamps,
-- explicit search/status, out-of-order source changes and archive/re-pair.
DO $mixed$
DECLARE u uuid:='00000000-0000-4000-8000-000000002173';a uuid;co uuid;mt uuid;mc uuid;me uuid;ow uuid;oc uuid;oe uuid;unverified uuid;d timestamptz;cv timestamptz;p uuid;c uuid;m1 uuid;m2 uuid;m3 uuid;m4 uuid;m5 uuid;t uuid;ot uuid;v jsonb;z jsonb;k uuid;ts timestamptz;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox217-mixed@example.test','{"full_name":"Mixed"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_config(user_id,account_id,phone_number_id,access_token,status) VALUES(u,a,'15550000193','fixture-meta-secret','connected') RETURNING updated_at INTO cv;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,provider_external_id) VALUES(a,'meta_cloud','connected','15550000193') RETURNING id,updated_at INTO mt,d;
 v=public.inbox_enroll_verified_channel(a,u,mt,'meta_cloud','15550000193',NULL,NULL,d,cv,clock_timestamp(),'meta-fixture',true);
 mc=(v->>'channel_id')::uuid;me=(v->>'membership_id')::uuid;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox217-mixed','15550000193') RETURNING id,updated_at INTO ow,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,ow,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,ow,'openwa','15550000193','inbox217-mixed',NULL,d,cv,clock_timestamp(),'ow-fixture',true);
 oc=(v->>'channel_id')::uuid;oe=(v->>'membership_id')::uuid;
 IF mc=oc THEN RAISE EXCEPTION 'cross-provider channel merged'; END IF;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox217-unverified','15550000193') RETURNING id INTO unverified;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000219','Mixed Contact') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id,status,unread_count) VALUES(u,a,p,'pending',0) RETURNING id INTO c;
 ts=clock_timestamp();
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at) VALUES(c,'agent','text','Meta outbound','sent','meta_cloud',mt,'meta-217-a',ts) RETURNING id INTO m1;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at) VALUES(c,'bot','text','Meta older','sent','meta_cloud',mt,'meta-217-b',ts-interval '1 second') RETURNING id INTO m2;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at) VALUES(c,'agent','text','OpenWA outbound','sent','openwa',ow,'ow-217-a',ts) RETURNING id INTO m3;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at) VALUES(c,'customer','text','Unverified connection','delivered','openwa',unverified,'ow-217-unverified',NULL) RETURNING id INTO m4;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,created_at) VALUES(c,'customer','text','Missing route','delivered',NULL) RETURNING id INTO m5;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(m1,a,c,'meta_cloud',mc,mt,me,'meta-217-a',clock_timestamp(),'fixture-a'),
 (m2,a,c,'meta_cloud',mc,mt,me,'meta-217-b',clock_timestamp(),'fixture-b'),
 (m3,a,c,'openwa',oc,ow,oe,'ow-217-a',clock_timestamp(),'fixture-c');
 IF public.inbox_backfill_verified_messages(a,100)<>3 OR public.inbox_backfill_verified_messages(a,100)<>0 THEN RAISE EXCEPTION 'mixed backfill'; END IF;
 SELECT id INTO STRICT t FROM public.inbox_threads WHERE account_id=a AND channel_id=mc;
 SELECT id INTO STRICT ot FROM public.inbox_threads WHERE account_id=a AND channel_id=oc;
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_read_page(a,u,'channels','active',NULL,NULL,NULL,NULL,NULL,NULL,30,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 OR v::text LIKE '%fixture-meta-secret%' OR v::text LIKE '%phone_number_id%' THEN RAISE EXCEPTION 'mixed catalog'; END IF;
 v=public.inbox_read_page(a,u,'connections','unknown',NULL,NULL,NULL,NULL,NULL,NULL,30,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v->'rows'->0->'payload'->>'id'<>unverified::text OR v->'rows'->0->'payload'->>'ready'<>'false' THEN RAISE EXCEPTION 'unverified registry scope %',v; END IF;
 v=public.inbox_read_page(a,u,'threads','active',mc,NULL,NULL,NULL,'pending','mixed',1,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v->'rows'->0->'payload'->>'unread_count_known'<>'0' OR v->'rows'->0->'payload'->>'last_message_id'<>m1::text THEN RAISE EXCEPTION 'outbound-only summary or search %',v; END IF;
 v=public.inbox_read_page(a,u,'history','active',mc,NULL,t,NULL,NULL,NULL,1,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>2 OR v->'rows'->0->'payload'->>'id'<>m1::text OR v->'rows'->1->'payload'->>'id'<>m2::text OR v->>'observed_highwater'<>'2' THEN RAISE EXCEPTION 'Meta history order %',v; END IF;
 v=public.inbox_read_page(a,u,'history','unknown',NULL,c,NULL,NULL,NULL,NULL,1,NULL,NULL);
 k=(v->'rows'->0->>'row_id')::uuid;
 IF jsonb_array_length(v->'rows')<>2 OR (v->'rows'->0->>'sort_at') IS NOT NULL THEN RAISE EXCEPTION 'null timestamp fixture'; END IF;
 z=public.inbox_read_page(a,u,'history','unknown',NULL,c,NULL,NULL,NULL,NULL,1,NULL,k);
 IF jsonb_array_length(z->'rows')<>1 OR z->'rows'->0->>'row_id'=k::text THEN RAISE EXCEPTION 'null keyset'; END IF;
 v=public.inbox_read_page(a,u,'counts','active',mc,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF v->'counts'->>'lane_messages'<>'2' OR v->'counts'->>'source_messages'<>'5' OR v->'counts'->>'associated_messages'<>'3' OR v->'counts'->>'unresolved_messages'<>'2' THEN RAISE EXCEPTION 'mixed counts %',v; END IF;
 EXECUTE 'RESET ROLE';
 UPDATE public.messages SET status='read',content_text='Edited outbound' WHERE id=m1;
 PERFORM public.inbox_rebuild_thread(a,t);
 UPDATE public.whatsapp_connections SET phone_identity='15550000993' WHERE id=ow;
 v=public.inbox_read_page(a,u,'history','historical',oc,NULL,ot,NULL,NULL,NULL,10,NULL,NULL);
 IF jsonb_array_length(v->'rows')<>1 OR v->'rows'->0->'payload'->>'id'<>m3::text THEN RAISE EXCEPTION 're-pair historical retention'; END IF;
 v=public.inbox_read_page(a,u,'threads','active',mc,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
 IF v->'rows'->0->'payload'->>'preview'<>'Edited outbound' OR v->'rows'->0->'payload'->>'last_message_id'<>m1::text THEN RAISE EXCEPTION 'rebuild/ACK preview'; END IF;
END $mixed$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
