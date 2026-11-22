BEGIN;
DO $mixed$
DECLARE u uuid:='00000000-0000-4000-8000-000000002203';a uuid;co uuid;mt uuid;mc uuid;me uuid;ow uuid;oc uuid;oe uuid;unverified uuid;d timestamptz;cv timestamptz;p uuid;c uuid;m1 uuid;m2 uuid;m3 uuid;m4 uuid;m5 uuid;t uuid;ot uuid;v jsonb;z jsonb;k uuid;ts timestamptz; fresh uuid; legacy uuid; other uuid; intent uuid; msg uuid; newcontact uuid; newthread uuid; key1 uuid:=gen_random_uuid(); key2 uuid:=gen_random_uuid(); key3 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox220-mixed@example.test','{"full_name":"Mixed"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_config(user_id,account_id,phone_number_id,access_token,status) VALUES(u,a,'15550000193','fixture-meta-secret','connected') RETURNING updated_at INTO cv;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,provider_external_id) VALUES(a,'meta_cloud','connected','15550000193') RETURNING id,updated_at INTO mt,d;
 v=public.inbox_enroll_verified_channel(a,u,mt,'meta_cloud','15550000193',NULL,NULL,d,cv,clock_timestamp(),'meta-fixture',true);
 mc=(v->>'channel_id')::uuid;me=(v->>'membership_id')::uuid;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox220-mixed','15550000193') RETURNING id,updated_at INTO ow,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,ow,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,ow,'openwa','15550000193','inbox220-mixed',NULL,d,cv,clock_timestamp(),'ow-fixture',true);
 oc=(v->>'channel_id')::uuid;oe=(v->>'membership_id')::uuid;
 IF mc=oc THEN RAISE EXCEPTION 'cross-provider channel merged'; END IF;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox220-unverified','15550000193') RETURNING id INTO unverified;
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
 v=public.inbox_policy_context(a,u,t,mc,mt);
 IF v->>'provider'<>'meta_cloud' OR v->>'last_inbound_at' IS NOT NULL OR v->>'ready'<>'true' THEN RAISE EXCEPTION 'no trusted inbound %',v; END IF;
 IF public.inbox_policy_context(a,u,t,mc,ow) IS NOT NULL OR public.inbox_policy_context(a,u,t,oc,mt) IS NOT NULL THEN RAISE EXCEPTION 'wrong provider/channel accepted'; END IF;
 ts=clock_timestamp();
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at) VALUES(c,'customer','text','signed Meta fresh','delivered','meta_cloud',mt,'meta-220-fresh',ts) RETURNING id INTO fresh;
 IF public.inbox_record_meta_signed_ingress(a,mt,c,fresh,'meta-220-fresh','wrong-id','15550000219',ts) THEN RAISE EXCEPTION 'wrong Meta external accepted'; END IF;
 IF public.inbox_record_meta_signed_ingress(a,mt,c,fresh,'meta-220-fresh','15550000193','15550000999',ts) THEN RAISE EXCEPTION 'wrong Meta sender accepted'; END IF;
 EXECUTE 'SET LOCAL ROLE service_role';
 IF NOT public.inbox_record_meta_signed_ingress(a,mt,c,fresh,'meta-220-fresh','15550000193','15550000219',ts) THEN RAISE EXCEPTION 'fresh Meta proof absent'; END IF;
 IF NOT public.inbox_record_meta_signed_ingress(a,mt,c,fresh,'meta-220-fresh','15550000193','15550000219',ts) OR (SELECT count(*) FROM public.inbox_message_memberships WHERE message_id=fresh)<>1 THEN RAISE EXCEPTION 'duplicate signed proof'; END IF;
 EXECUTE 'RESET ROLE';
 v=public.inbox_policy_context(a,u,t,mc,NULL);
 IF (v->>'last_inbound_at')::timestamptz IS DISTINCT FROM ts OR v->>'connection_id'<>mt::text THEN RAISE EXCEPTION 'exact signed Meta window %',v; END IF;

 EXECUTE 'SET LOCAL ROLE service_role';
 IF public.inbox_native_action_target(a,u,t,mc,mt,me,fresh,true)->>'native_id' IS DISTINCT FROM 'meta-220-fresh' THEN RAISE EXCEPTION 'exact read proof'; END IF;
 IF public.inbox_native_action_target(a,u,t,mc,mt,me,m3,false) IS NOT NULL THEN RAISE EXCEPTION 'cross-provider reply'; END IF;
 v=public.inbox_claim_action(a,u,key1,t,mc,mt,me,'meta_cloud','send',repeat('a',64));
 IF v->>'state'<>'claimed' THEN RAISE EXCEPTION 'claim %',v; END IF;
 intent=(v->>'intent_id')::uuid;
 IF public.inbox_claim_action(a,u,key1,t,mc,mt,me,'meta_cloud','send',repeat('a',64))->>'state'<>'pending' THEN RAISE EXCEPTION 'duplicate claim'; END IF;
 IF public.inbox_claim_action(a,u,key1,t,mc,mt,me,'meta_cloud','send',repeat('b',64))->>'state'<>'conflict' THEN RAISE EXCEPTION 'changed payload'; END IF;
 msg=public.inbox_reserve_action_message(a,u,intent,'15550000219','text','reply fixture',NULL,NULL,NULL,fresh);
 IF NOT public.inbox_begin_action_dispatch(a,u,intent,'15550000219') THEN RAISE EXCEPTION 'dispatch denied'; END IF;
 IF public.inbox_begin_action_dispatch(a,u,intent,'15550000219') THEN RAISE EXCEPTION 'dispatch fence'; END IF;
 IF public.inbox_complete_action_send(a,u,intent,'meta-221-result','15550000219')<>msg THEN RAISE EXCEPTION 'completion key'; END IF;
 IF public.inbox_claim_action(a,u,key1,t,mc,mt,me,'meta_cloud','send',repeat('a',64))->>'state'<>'accepted' THEN RAISE EXCEPTION 'accepted replay'; END IF;
 IF (SELECT count(*) FROM public.inbox_message_memberships WHERE message_id=msg AND thread_id=t AND connection_id=mt AND membership_id=me)<>1 THEN RAISE EXCEPTION 'outbound projection'; END IF;
 IF public.inbox_native_action_target(a,u,t,mc,mt,me,msg,false)->>'native_id' IS DISTINCT FROM 'meta-221-result' THEN RAISE EXCEPTION 'outbound reply proof'; END IF;
 v=public.inbox_claim_action(a,u,key2,t,mc,mt,me,'meta_cloud','send',repeat('c',64));
 intent=(v->>'intent_id')::uuid;
 msg=public.inbox_reserve_action_message(a,u,intent,'15550000219','text','blocked fixture',NULL,NULL,NULL,NULL);
 IF public.inbox_fail_action(a,u,intent)<>'blocked' THEN RAISE EXCEPTION 'blocked state'; END IF;
 v=public.inbox_claim_action(a,u,key3,t,mc,mt,me,'meta_cloud','send',repeat('d',64));
 intent=(v->>'intent_id')::uuid;
 msg=public.inbox_reserve_action_message(a,u,intent,'15550000219','text','uncertain fixture',NULL,NULL,NULL,NULL);
 IF NOT public.inbox_begin_action_dispatch(a,u,intent,'15550000219') THEN RAISE EXCEPTION 'dispatch denied'; END IF;
 IF public.inbox_fail_action(a,u,intent)<>'uncertain' THEN RAISE EXCEPTION 'uncertain state'; END IF;
 IF public.inbox_claim_action(a,u,key3,t,mc,mt,me,'meta_cloud','send',repeat('d',64))->>'state'<>'uncertain' THEN RAISE EXCEPTION 'unsafe retry'; END IF;
 IF has_table_privilege('authenticated','public.inbox_action_intents','SELECT') OR has_function_privilege('authenticated','public.inbox_claim_action(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'browser grant'; END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT status FROM public.messages WHERE id=msg)<>'sending' THEN RAISE EXCEPTION 'uncertain source lost'; END IF;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000288','Outbound only') RETURNING id INTO newcontact;
 EXECUTE 'SET LOCAL ROLE service_role';
 newthread=public.inbox_open_explicit_thread(a,u,newcontact,mc,mt,me,'meta_cloud');
 IF public.inbox_open_explicit_thread(a,u,newcontact,mc,mt,me,'meta_cloud')<>newthread THEN RAISE EXCEPTION 'duplicate outbound thread'; END IF;
 IF public.inbox_policy_context(a,u,newthread,mc,mt)->>'last_inbound_at' IS NOT NULL THEN RAISE EXCEPTION 'outbound thread opened Meta window'; END IF;
 EXECUTE 'RESET ROLE';
 UPDATE public.profiles SET account_role='viewer' WHERE user_id=u;
 BEGIN
 PERFORM public.inbox_claim_action(a,u,gen_random_uuid(),t,mc,mt,me,'meta_cloud','send',repeat('a',64));
 RAISE EXCEPTION 'viewer claim';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $mixed$;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002201';u2 uuid:='00000000-0000-4000-8000-000000002202';a uuid;a2 uuid;pri uuid;sec uuid;x uuid;ch uuid;ch2 uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;p2 uuid;c2 uuid;token uuid;mid uuid;t uuid;t2 uuid;raw uuid;anchor uuid;at timestamptz;arr jsonb;z jsonb;scope text;tg uuid;fg uuid;legacy_before integer; intent uuid; msg uuid; selected_epoch uuid; inbound_id uuid; request_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox220@example.test','{"full_name":"Inbox 219"}'),(u2,'inbox220-foreign@example.test','{"full_name":"Foreign"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 SELECT account_id INTO STRICT a2 FROM public.profiles WHERE user_id=u2;
 FOR i IN 1..3 LOOP
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity,display_name,provider_metadata) VALUES(a,'openwa','ready','inbox220-'||i,CASE WHEN i<3 THEN '15550000191' ELSE '15550000192' END,'Session '||i,'{"secret":"never-return"}') RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa',CASE WHEN i<3 THEN '15550000191' ELSE '15550000192' END,'inbox220-'||i,NULL,d,cv,clock_timestamp(),'fixture-'||i,i<>2);
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
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,CASE WHEN i=1 THEN pri WHEN i=2 THEN sec ELSE x END,'openwa','read220-'||i,clock_timestamp(),token,clock_timestamp());
  v=public.inbox_commit_canonical_inbound_context(a,CASE WHEN i=1 THEN pri WHEN i=2 THEN sec ELSE x END,'read220-'||i,token,c,'inbox220-'||i,NULL,'native220',true,'text','body',NULL,'15550000217@c.us',at,NULL,'{}',false,false);
  IF i<>2 AND v->>'state'<>'inserted' THEN RAISE EXCEPTION 'fixture %',v; END IF;
 END LOOP;
 SELECT id INTO STRICT t FROM public.inbox_threads WHERE account_id=a AND channel_id=ch AND conversation_id=c;
 SELECT id INTO STRICT t2 FROM public.inbox_threads WHERE account_id=a AND channel_id=ch2 AND conversation_id=c;

 SELECT id INTO STRICT selected_epoch FROM public.whatsapp_channel_memberships WHERE account_id=a AND connection_id=pri AND valid_until IS NULL;
 SELECT message_id INTO STRICT inbound_id FROM public.inbox_message_memberships WHERE account_id=a AND thread_id=t AND connection_id=pri;
 EXECUTE 'SET LOCAL ROLE service_role';
 IF public.inbox_native_action_target(a,u,t,ch,pri,selected_epoch,inbound_id,true)->>'native_id' IS DISTINCT FROM 'native220' THEN RAISE EXCEPTION 'OpenWA native route'; END IF;
 v=public.inbox_claim_action(a,u,request_id,t,ch,pri,selected_epoch,'openwa','send',repeat('a',64));
 IF v->>'state'<>'claimed' THEN RAISE EXCEPTION 'OpenWA claim %',v; END IF;
 intent=(v->>'intent_id')::uuid;
 msg=public.inbox_reserve_action_message(a,u,intent,'15550000217@c.us','text','OpenWA fixture',NULL,NULL,NULL,inbound_id);
 IF NOT public.inbox_begin_action_dispatch(a,u,intent,'15550000217@c.us') THEN RAISE EXCEPTION 'OpenWA dispatch'; END IF;
 IF public.inbox_complete_action_send(a,u,intent,'native221-out','15550000217@c.us')<>msg THEN RAISE EXCEPTION 'OpenWA complete'; END IF;
 IF public.inbox_claim_action(a,u,request_id,t,ch,pri,selected_epoch,'openwa','send',repeat('a',64))->>'state'<>'accepted' THEN RAISE EXCEPTION 'OpenWA replay'; END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT count(*) FROM public.inbox_canonical_messages WHERE account_id=a AND source_message_id=msg AND direction='outbound')<>1 THEN RAISE EXCEPTION 'canonical outbound'; END IF;
 token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,pri,'openwa','echo221',clock_timestamp(),token,clock_timestamp());
 v=public.inbox_commit_outbound_echo(a,pri,'echo221',token,'inbox220-1',NULL,c,'native221-out',true,'15550000217@c.us','15550000217','text','OpenWA fixture',NULL,clock_timestamp(),'{}');
 IF v->>'state'<>'existing' OR v->>'messageId' IS DISTINCT FROM msg::text THEN RAISE EXCEPTION 'echo dedup %',v; END IF;
END $test$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
