BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002151';a uuid;s uuid;c uuid;p uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;can uuid;mid uuid;rt uuid;cl uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox215@example.test','{"full_name":"Inbox 215"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox215','15550000181') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000181','inbox215',NULL,d,cv,clock_timestamp(),'fixture',true);
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,s,ep,'fixture','fixture');
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000215','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 rt=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,s,'openwa','inbox215-event',clock_timestamp(),rt,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,s,'inbox215-event',rt,c,'inbox215',NULL,'native215',true,'text','body',NULL,'15550000215@c.us',clock_timestamp(),NULL,'{}',false,false);
 IF v->>'state'<>'inserted' THEN RAISE EXCEPTION 'source'; END IF;
 can=(v->>'canonicalId')::uuid;mid=(v->>'messageId')::uuid;
 IF NOT public.inbox_validate_canonical_route(a,c,mid,s) OR public.inbox_validate_canonical_route(gen_random_uuid(),c,mid,s) THEN RAISE EXCEPTION 'route scope'; END IF;
 cl=public.inbox_claim_canonical_effect(a,can,s,'inbox215-event',rt);
 IF cl IS NULL THEN RAISE EXCEPTION 'claim'; END IF;
 IF NOT public.inbox_begin_canonical_stage(a,can,cl,'flows') THEN RAISE EXCEPTION 'stage begin'; END IF;
 IF public.inbox_begin_canonical_stage(a,can,cl,'flows') OR public.inbox_begin_canonical_stage(a,can,gen_random_uuid(),'agent_dispatch') THEN RAISE EXCEPTION 'duplicate/foreign stage'; END IF;
 IF NOT public.inbox_finish_canonical_stage(a,can,cl,'flows',true) THEN RAISE EXCEPTION 'stage finish'; END IF;
 IF NOT public.inbox_begin_canonical_stage(a,can,cl,'agent_dispatch') THEN RAISE EXCEPTION 'stage begin second'; END IF;
 UPDATE public.inbox_canonical_effects SET claimed_at=clock_timestamp()-interval '16 minutes' WHERE canonical_id=can;
 IF public.inbox_recover_stale_canonical_effects(10)<>1 THEN RAISE EXCEPTION 'stale claim sweep'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages WHERE canonical_id=can AND stage_key='flows' AND state='returned')
 OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages WHERE canonical_id=can AND stage_key='agent_dispatch' AND state='review')
 OR NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effects WHERE canonical_id=can AND state='review')
 OR public.inbox_claim_canonical_effect(a,can,s,'inbox215-event',rt) IS NOT NULL THEN RAISE EXCEPTION 'uncertain stage replay'; END IF;
 UPDATE public.whatsapp_connections SET status='disconnected' WHERE id=s;
 IF public.inbox_validate_canonical_route(a,c,mid,s) THEN RAISE EXCEPTION 'invalid epoch still routable'; END IF;
 IF has_table_privilege('authenticated','public.inbox_canonical_effect_stages','SELECT') OR has_function_privilege('anon','public.inbox_recover_stale_canonical_effects(integer)','EXECUTE') THEN RAISE EXCEPTION 'recovery ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
