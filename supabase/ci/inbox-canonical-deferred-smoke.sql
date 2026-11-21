BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002131';a uuid;s uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;p uuid;c uuid;canon uuid;token uuid;lease uuid;j uuid;rid uuid;cl uuid;payload jsonb;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox213@example.test','{"full_name":"Inbox 213"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox213','15550000161') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000161','inbox213',NULL,d,cv,clock_timestamp(),'fixture',true);
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000213','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,s,ep,'fixture-namespace','fixture');
 token=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
 VALUES(a,s,'openwa','inbox213-event',clock_timestamp(),token,clock_timestamp()) RETURNING id INTO rid;
 payload=jsonb_build_object('message',jsonb_build_object('provider','openwa','connectionId',s,'providerMessageId','native213','providerMessageIdentityKind','native','providerEventId','inbox213-event','providerMetadata',jsonb_build_object('sessionId','inbox213'),'providerChatId','123456789012345@lid'));
 IF NOT public.defer_openwa_webhook_event(a,s,'inbox213','inbox213-event','native213','unresolved_identity','123456789012345@lid',payload,token) THEN RAISE EXCEPTION 'defer failed'; END IF;
 SELECT id INTO STRICT j FROM public.openwa_deferred_events WHERE account_id=a AND connection_id=s AND provider_event_id='inbox213-event';
 lease=gen_random_uuid();
 UPDATE public.openwa_deferred_events SET state='leased',lease_token=lease,lease_until=clock_timestamp()+interval '3 minutes' WHERE id=j;
 IF public.inbox_authorized_receipt(a,s,'inbox213-event',token,'native213') IS NOT NULL OR public.inbox_authorized_receipt(a,s,'inbox213-event',lease,'wrong') IS NOT NULL OR public.inbox_authorized_receipt(a,s,'inbox213-event',lease,'native213') IS DISTINCT FROM rid THEN RAISE EXCEPTION 'deferred lease scope'; END IF;
 v=public.inbox_commit_canonical_inbound_context(a,s,'inbox213-event',lease,c,'inbox213',NULL,'native213',true,'text','body',NULL,'123456789012345@lid',clock_timestamp(),NULL,'{"text":"body"}',true,true);
 IF v->>'state'<>'inserted' THEN RAISE EXCEPTION 'deferred canonical commit %',v; END IF;
 canon=(v->>'canonicalId')::uuid;
 cl=public.inbox_claim_canonical_effect(a,canon,s,'inbox213-event',lease);
 IF cl IS NULL OR public.inbox_claim_canonical_effect(a,canon,s,'inbox213-event',lease) IS NOT NULL THEN RAISE EXCEPTION 'deferred claim'; END IF;
 IF NOT public.inbox_finish_canonical_effect(a,canon,cl,true) OR public.inbox_canonical_receipt_outcome(a,s,'inbox213-event',lease,'native213')->>'state'<>'completed' THEN RAISE EXCEPTION 'deferred outcome'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=rid AND processed_at IS NOT NULL AND processing_token IS NULL) THEN RAISE EXCEPTION 'receipt reopened'; END IF;
 UPDATE public.openwa_deferred_events SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j;
 IF public.inbox_authorized_receipt(a,s,'inbox213-event',lease,'native213') IS NOT NULL THEN RAISE EXCEPTION 'expired lease accepted'; END IF;
 IF has_function_privilege('authenticated','public.inbox_authorized_receipt(uuid,uuid,text,uuid,text)','EXECUTE') OR has_function_privilege('anon','public.inbox_canonical_receipt_outcome(uuid,uuid,text,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'browser receipt access'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
