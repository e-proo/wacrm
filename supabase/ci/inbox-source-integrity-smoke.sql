-- All tests rollback, no provider/network calls.
BEGIN;
DO $$
DECLARE u uuid:='00000000-0000-4000-8000-000000002071'; a uuid; c1 uuid; c2 uuid; c3 uuid; p1 uuid; p2 uuid; p3 uuid; s uuid; s2 uuid; ch uuid; ep uuid; ep2 uuid; m1 uuid; m2 uuid; t1 uuid; t2 uuid; d timestamptz; cv timestamptz; v jsonb; snap record; audit_n int;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox207@example.test','{"full_name":"Inbox 207"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox207-a','15550000111') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','synthetic') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000111','inbox207-a',NULL,d,cv,clock_timestamp(),'fixture-a',true);
 ch=(v->>'channel_id')::uuid; ep=(v->>'membership_id')::uuid;
 PERFORM public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000111','inbox207-a',NULL,d,cv,clock_timestamp(),'fixture-reverify',false);
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox207-b','15550000111') RETURNING id,updated_at INTO s2,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s2,'openwa','https://example.test','synthetic') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s2,'openwa','15550000111','inbox207-b',NULL,d,cv,clock_timestamp(),'fixture-b',true);
 ep2=(v->>'membership_id')::uuid;
 IF (v->>'channel_id')::uuid<>ch OR NOT EXISTS(SELECT 1 FROM public.inbox_integrity_audit WHERE account_id=a AND actor_id=u AND event_type='identity_reverified' AND membership_id=ep)
 OR (SELECT count(*) FROM public.inbox_integrity_audit WHERE account_id=a AND actor_id=u AND event_type='primary_selected')<>2
 THEN RAISE EXCEPTION 'actor audit missing'; END IF;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000201','Fixture1') RETURNING id INTO p1;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000202','Fixture2') RETURNING id INTO p2;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000203','Fixture3') RETURNING id INTO p3;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p1,2) RETURNING id INTO c1;
 INSERT INTO public.conversations(user_id,account_id,contact_id,unread_count) VALUES(u,a,p2,0) RETURNING id INTO c2;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
 VALUES(c1,'customer','text','old','delivered','openwa',s,'207-a','207-a',clock_timestamp()) RETURNING id INTO m1;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
 VALUES(c1,'customer','text','new','delivered','openwa',s2,'207-b','207-b',clock_timestamp()+interval '1 second') RETURNING id INTO m2;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(m1,a,c1,'openwa',ch,s,ep,'207-a',clock_timestamp(),'proof-a'),(m2,a,c1,'openwa',ch,s2,ep2,'207-b',clock_timestamp(),'proof-b');
 IF public.inbox_backfill_verified_messages(a,100)<>2 THEN RAISE EXCEPTION 'backfill'; END IF;
 SELECT id INTO STRICT t1 FROM public.inbox_threads WHERE account_id=a AND conversation_id=c1 AND channel_id=ch;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1 AND last_message_id=m2 AND last_message_preview='new' AND unread_count_known=0 AND last_trusted_inbound_at IS NULL) THEN RAISE EXCEPTION 'backfill summary'; END IF;
 UPDATE public.messages SET content_text='edited' WHERE id=m2;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1 AND last_message_preview='edited') THEN RAISE EXCEPTION 'edit summary'; END IF;
 UPDATE public.messages SET status='read' WHERE id=m2;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1 AND last_message_id=m2 AND ingest_highwater=2 AND unread_count_known=0) THEN RAISE EXCEPTION 'ACK reordered'; END IF;
 -- Legacy merge function moves messages before deleting losing parent.
 UPDATE public.messages SET conversation_id=c2 WHERE id=m2;
 SELECT id INTO STRICT t2 FROM public.inbox_threads WHERE account_id=a AND conversation_id=c2 AND channel_id=ch;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=m2 AND conversation_id=c2 AND thread_id=t2 AND membership_id=ep2)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE message_id=m2 AND conversation_id=c2 AND membership_id=ep2)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1 AND last_message_id=m1 AND last_message_preview='old')
 OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t2 AND last_message_id=m2 AND last_message_preview='edited') THEN RAISE EXCEPTION 'reparent projection'; END IF;
 UPDATE public.conversations SET contact_id=p3 WHERE id=c2;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t2 AND conversation_id=c2) THEN RAISE EXCEPTION 'contact reparent lost thread'; END IF;
 UPDATE public.conversations SET unread_count=3 WHERE id=c1;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_legacy_unread WHERE account_id=a AND conversation_id=c1 AND unread_count=3) THEN RAISE EXCEPTION 'legacy unread sync'; END IF;
 UPDATE public.messages SET provider_message_id='207-b-corrected' WHERE id=m2;
 IF EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=m2) OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE message_id=m2)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t2 AND last_message_id IS NULL AND last_message_preview IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_integrity_audit WHERE account_id=a AND message_id=m2 AND event_type='message_identity_invalidated')
 THEN RAISE EXCEPTION 'identity change not quarantined'; END IF;
 DELETE FROM public.messages WHERE id=m1;
 IF EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=m1)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1 AND last_message_id IS NULL AND last_message_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.inbox_integrity_audit WHERE account_id=a AND message_id=m1 AND event_type='message_deleted') THEN RAISE EXCEPTION 'delete consistency'; END IF;
 UPDATE public.whatsapp_connection_credentials SET api_key_encrypted='rotated' WHERE connection_id=s2;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_integrity_audit WHERE account_id=a AND membership_id=ep2 AND event_type='membership_closed') THEN RAISE EXCEPTION 'closure audit'; END IF;
 DELETE FROM public.conversations WHERE id=c1;
 IF EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t1) OR EXISTS(SELECT 1 FROM public.inbox_legacy_unread WHERE conversation_id=c1) THEN RAISE EXCEPTION 'parent cascade'; END IF;
 IF public.inbox_rebuild_thread(a,t1) THEN RAISE EXCEPTION 'missing thread rebuilt'; END IF;
 IF NOT public.inbox_rebuild_thread(a,t2) OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE id=t2 AND last_message_id IS NULL AND unread_count_known=0) THEN RAISE EXCEPTION 'rebuild mismatch'; END IF;
 IF has_table_privilege('authenticated','public.inbox_integrity_audit','SELECT') OR has_table_privilege('service_role','public.inbox_integrity_audit','UPDATE') OR has_table_privilege('service_role','public.inbox_integrity_audit','DELETE') OR has_table_privilege('service_role','public.inbox_integrity_audit','TRUNCATE') OR has_function_privilege('authenticated','public.inbox_rebuild_thread(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'audit/rebuild ACL'; END IF;
END $$;

DO $priv$
DECLARE u uuid:='00000000-0000-4000-8000-000000002072'; foreign_u uuid:='00000000-0000-4000-8000-000000002073'; a uuid; b uuid; p uuid; fp uuid; c uuid; s uuid; ch uuid; ep uuid; m uuid; t uuid; d timestamptz; cv timestamptz; v jsonb;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox207-priv@example.test','{"full_name":"Inbox Priv"}'),(foreign_u,'inbox207-other@example.test','{"full_name":"Inbox Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 SELECT account_id INTO STRICT b FROM public.profiles WHERE user_id=foreign_u;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000204','Scope') RETURNING id INTO p;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(foreign_u,b,'+15550000205','Foreign scope') RETURNING id INTO fp;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 BEGIN
  UPDATE public.conversations SET contact_id=fp WHERE id=c;
  RAISE EXCEPTION 'cross-tenant contact accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox207-priv','15550000112') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','synthetic') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000112','inbox207-priv',NULL,d,cv,clock_timestamp(),'fixture-priv',false);
 ch=(v->>'channel_id')::uuid; ep=(v->>'membership_id')::uuid;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
 VALUES(c,'customer','text','private fixture','delivered','openwa',s,'207-priv','207-priv',clock_timestamp()) RETURNING id INTO m;
 INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(a,c,ch,'openwa') RETURNING id INTO t;
 BEGIN
  INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
  VALUES(m,a,c,ch,t,'openwa',s,ep,'verified_current_ingress','forged',1);
  RAISE EXCEPTION 'current ingress activated early';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
  VALUES(m,a,c,ch,t,'openwa',s,ep,'verified_historical_epoch','no-proof',1);
  RAISE EXCEPTION 'unproven historical association accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(m,a,c,'openwa',ch,s,ep,'207-priv',clock_timestamp(),'proof-priv');
 PERFORM public.inbox_backfill_verified_messages(a,100);
 PERFORM set_config('inbox207.user',u::text,true);
 PERFORM set_config('inbox207.message',m::text,true);
 PERFORM set_config('inbox207.parent',c::text,true);
END $priv$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('inbox207.user'),true);
DO $browser$
BEGIN
 BEGIN
  UPDATE public.messages SET created_at=clock_timestamp()+interval '1 hour' WHERE id=current_setting('inbox207.message')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'browser modified verified timestamp'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.messages SET sender_type='agent' WHERE id=current_setting('inbox207.message')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'browser modified verified sender'; END IF;
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $browser$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true);
DELETE FROM public.conversations WHERE id=current_setting('inbox207.parent')::uuid;
DO $cascade$ BEGIN
 IF EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=current_setting('inbox207.message')::uuid)
 OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE message_id=current_setting('inbox207.message')::uuid)
 OR EXISTS(SELECT 1 FROM public.inbox_threads WHERE conversation_id=current_setting('inbox207.parent')::uuid)
 THEN RAISE EXCEPTION 'cascade leaves orphan'; END IF;
END $cascade$;

SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
