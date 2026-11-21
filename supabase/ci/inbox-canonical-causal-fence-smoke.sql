BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002161';a uuid;s uuid;c uuid;p uuid;ch uuid;ep uuid;d timestamptz;cv timestamptz;v jsonb;can uuid;mid uuid;rt uuid;cl uuid;ap uuid;ag uuid;rev uuid;run uuid;scope jsonb;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox216@example.test','{"full_name":"Inbox 216"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox216','15550000182') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000182','inbox216',NULL,d,cv,clock_timestamp(),'fixture',true);
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,s,ep,'fixture','fixture');
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000216','Fixture') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 rt=gen_random_uuid();
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at) VALUES(a,s,'openwa','inbox216-event',clock_timestamp(),rt,clock_timestamp());
 v=public.inbox_commit_canonical_inbound_context(a,s,'inbox216-event',rt,c,'inbox216',NULL,'native216',true,'text','body',NULL,'15550000216@c.us',clock_timestamp(),NULL,'{}',false,false);
 IF v->>'state'<>'inserted' THEN RAISE EXCEPTION 'source'; END IF;
 can=(v->>'canonicalId')::uuid;mid=(v->>'messageId')::uuid;
 INSERT INTO public.ai_provider_connections(account_id,name,preset_id,protocol,api_root,encrypted_api_key,connection_fingerprint) VALUES(a,'fixture','fixture','openai','https://example.test','fixture','fixture') RETURNING id INTO ap;
 INSERT INTO public.ai_agents(account_id,slug,name) VALUES(a,'inbox216','Fixture') RETURNING id INTO ag;
 INSERT INTO public.ai_agent_revisions(account_id,agent_id,revision_number,provider_connection_id,model) VALUES(a,ag,1,ap,'fixture') RETURNING id INTO rev;
 INSERT INTO public.ai_agent_runs(account_id,conversation_id,ai_agent_id,agent_revision_id,provider_connection_id,plane,idempotency_key,run_mode,inbound_message_id) VALUES(a,c,ag,rev,ap,'customer','inbox216-run','inbound',mid) RETURNING id INTO run;
 EXECUTE 'SET LOCAL ROLE service_role';
 scope=public.inbox_canonical_agent_run_scope(a,c,run);
 IF scope->>'messageId' IS DISTINCT FROM mid::text OR scope->>'connectionId' IS DISTINCT FROM s::text THEN RAISE EXCEPTION 'queued causal scope'; END IF;
 IF public.inbox_canonical_receipt_outcome(a,s,'inbox216-event',rt,'native216')->>'messageId' IS DISTINCT FROM mid::text THEN RAISE EXCEPTION 'same epoch media'; END IF;
 BEGIN PERFORM public.inbox_canonical_agent_run_scope(gen_random_uuid(),c,run); RAISE EXCEPTION 'foreign run accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 EXECUTE 'RESET ROLE';
 IF NOT public.inbox_validate_canonical_route(a,c,mid,s) OR public.inbox_validate_canonical_route(gen_random_uuid(),c,mid,s) THEN RAISE EXCEPTION 'route scope'; END IF;
 cl=public.inbox_claim_canonical_effect(a,can,s,'inbox216-event',rt);
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
 OR public.inbox_claim_canonical_effect(a,can,s,'inbox216-event',rt) IS NOT NULL THEN RAISE EXCEPTION 'uncertain stage replay'; END IF;
 UPDATE public.messages SET provider_message_id='corrected-native216' WHERE id=mid;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_messages WHERE id=can AND first_source_message_id=mid AND source_message_id IS NULL) THEN RAISE EXCEPTION 'missing tombstone source witness'; END IF;
 BEGIN PERFORM public.inbox_canonical_agent_run_scope(a,c,run); RAISE EXCEPTION 'tombstone allowed fallback'; EXCEPTION WHEN check_violation THEN NULL; END;
 IF public.inbox_canonical_receipt_outcome(a,s,'inbox216-event',rt,'native216') ? 'messageId' THEN RAISE EXCEPTION 'tombstone media retry'; END IF;
 IF has_function_privilege('authenticated','public.inbox_canonical_agent_run_scope(uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'browser scope'; END IF;
 UPDATE public.whatsapp_connections SET status='disconnected' WHERE id=s;
 IF public.inbox_validate_canonical_route(a,c,mid,s) THEN RAISE EXCEPTION 'invalid epoch still routable'; END IF;
 IF has_table_privilege('authenticated','public.inbox_canonical_effect_stages','SELECT') OR has_function_privilege('anon','public.inbox_recover_stale_canonical_effects(integer)','EXECUTE') THEN RAISE EXCEPTION 'recovery ACL'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
