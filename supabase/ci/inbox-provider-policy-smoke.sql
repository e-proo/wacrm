BEGIN;
DO $mixed$
DECLARE u uuid:='00000000-0000-4000-8000-000000002203';a uuid;co uuid;mt uuid;mc uuid;me uuid;ow uuid;oc uuid;oe uuid;unverified uuid;d timestamptz;cv timestamptz;p uuid;c uuid;m1 uuid;m2 uuid;m3 uuid;m4 uuid;m5 uuid;t uuid;ot uuid;v jsonb;z jsonb;k uuid;ts timestamptz; fresh uuid; legacy uuid; other uuid;
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
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at)
 VALUES(c,'customer','text','untrusted newer Meta','delivered','meta_cloud',mt,'meta-220-untrusted',clock_timestamp()) RETURNING id INTO legacy;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,created_at)
 VALUES(c,'customer','text','unrelated newer OpenWA','delivered','openwa',ow,'ow-220-other',clock_timestamp()) RETURNING id INTO other;
 v=public.inbox_policy_context(a,u,t,mc,mt);
 IF (v->>'last_inbound_at')::timestamptz IS DISTINCT FROM ts THEN RAISE EXCEPTION 'untrusted inbound opened window'; END IF;
 UPDATE public.contacts SET phone='+15550000229' WHERE id=p;
 v=public.inbox_policy_context(a,u,t,mc,mt);
 IF v->>'last_inbound_at' IS NOT NULL THEN RAISE EXCEPTION 'phone change reused window'; END IF;
 UPDATE public.contacts SET phone='+15550000219' WHERE id=p;
 EXECUTE 'SET LOCAL ROLE service_role';
 v=public.inbox_policy_context(a,u,t,mc,mt);
 IF (v->>'last_inbound_at')::timestamptz IS DISTINCT FROM ts THEN RAISE EXCEPTION 'service role policy unavailable'; END IF;
 IF has_function_privilege('authenticated','public.inbox_policy_context(uuid,uuid,uuid,uuid,uuid)','EXECUTE') OR has_function_privilege('anon','public.inbox_record_meta_signed_ingress(uuid,uuid,uuid,uuid,text,text,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'browser policy/proof RPC'; END IF;
 EXECUTE 'RESET ROLE';
 UPDATE public.whatsapp_connections SET status='disconnected' WHERE id=mt;
 v=public.inbox_policy_context(a,u,t,mc,mt);
 IF v IS NOT NULL THEN RAISE EXCEPTION 'closed epoch selectable'; END IF;
END $mixed$;

DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002201';u2 uuid:='00000000-0000-4000-8000-000000002202';a uuid;a2 uuid;pri uuid;sec uuid;x uuid;ch uuid;ch2 uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;p2 uuid;c2 uuid;token uuid;mid uuid;t uuid;t2 uuid;raw uuid;anchor uuid;at timestamptz;arr jsonb;z jsonb;scope text;tg uuid;fg uuid;legacy_before integer;
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
 INSERT INTO public.whatsapp_connection_guardrails(account_id,connection_id,hourly_cap,daily_cap,first_touch_daily_cap,warmup_until,manual_paused,pilot_enabled)
 VALUES(a,pri,1,10,10,NULL,false,false),(a,sec,1,10,10,NULL,false,false),(a,x,5,10,10,NULL,false,false)
 ON CONFLICT(connection_id) DO UPDATE SET hourly_cap=excluded.hourly_cap,daily_cap=excluded.daily_cap,first_touch_daily_cap=excluded.first_touch_daily_cap,warmup_until=NULL,manual_paused=false,pilot_enabled=false;
 v=public.inbox_policy_context(a,u,t,ch,pri);
 IF v->>'recipient'<>'15550000217@c.us' OR v->>'last_inbound_at' IS NOT NULL OR v->>'ready'<>'true' THEN RAISE EXCEPTION 'OpenWA policy context %',v; END IF;
 v=public.inbox_policy_context(a,u,t,ch,sec);
 -- Other-channel OpenWA inbound exists in this fixture; no phone guess.
 IF v->>'recipient' IS NOT NULL THEN RAISE EXCEPTION 'ambiguous secondary recipient %',v; END IF;
 IF public.inbox_policy_context(a,u,t,ch,x) IS NOT NULL THEN RAISE EXCEPTION 'different number accepted'; END IF;
 BEGIN PERFORM public.inbox_policy_context(a,u2,t,ch,pri); RAISE EXCEPTION 'foreign policy actor'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 v=public.reserve_openwa_guardrail_send(a,pri,repeat('a',64),'manual');
 IF v->>'allowed'<>'true' THEN RAISE EXCEPTION 'existing reservation denied %',v; END IF;
 IF public.inbox_openwa_channel_cap_reason(a,ch,sec,repeat('b',64)) IS DISTINCT FROM 'channel_hourly_cap' THEN RAISE EXCEPTION 'aggregate cap preview'; END IF;
 BEGIN PERFORM public.reserve_openwa_guardrail_send(a,sec,repeat('b',64),'manual'); RAISE EXCEPTION 'secondary bypassed channel cap';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'INBOX_CHANNEL_CAP:channel_hourly_cap' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM public.whatsapp_guardrail_events WHERE account_id=a AND connection_id IN(pri,sec) AND decision='reserved')<>1 THEN RAISE EXCEPTION 'second reservation recorded'; END IF;
 v=public.reserve_openwa_guardrail_send(a,x,repeat('c',64),'manual');
 IF v->>'allowed'<>'true' THEN RAISE EXCEPTION 'independent channel incorrectly blocked'; END IF;
 UPDATE public.whatsapp_connection_guardrails SET manual_paused=true WHERE account_id=a AND connection_id=x;
 v=public.reserve_openwa_guardrail_send(a,x,repeat('d',64),'manual');
 IF v->>'allowed'<>'false' OR v->>'reason'<>'manual_pause' THEN RAISE EXCEPTION 'existing stop lost'; END IF;
 UPDATE public.profiles SET account_role='viewer' WHERE user_id=u;
 v=public.inbox_policy_context(a,u,t,ch,pri);
 IF v->>'can_operate'<>'false' THEN RAISE EXCEPTION 'viewer role allowed'; END IF;
 UPDATE public.profiles SET account_role='owner' WHERE user_id=u;
END $test$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
