-- SOF-76 foundation smoke, disposable fixtures only. No dispatch.
BEGIN;
DO $schema$
DECLARE t text; r text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_channels','whatsapp_channel_memberships','inbox_threads','inbox_message_memberships','inbox_legacy_unread'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=to_regclass('public.'||t)) THEN
      RAISE EXCEPTION 'missing RLS: %',t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
        IF has_table_privilege(r,'public.'||t,p) THEN RAISE EXCEPTION 'browser ACL leaked % % %',r,t,p; END IF;
      END LOOP;
    END LOOP;
    IF has_table_privilege('service_role','public.'||t,'DELETE') OR has_table_privilege('service_role','public.'||t,'TRUNCATE')
      THEN RAISE EXCEPTION 'destructive service ACL on %',t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['messages','conversations','whatsapp_connections'] LOOP
    IF has_table_privilege('anon','public.'||t,'TRUNCATE') OR has_table_privilege('authenticated','public.'||t,'TRUNCATE')
      THEN RAISE EXCEPTION 'legacy truncate ACL remains %',t; END IF;
  END LOOP;
  IF has_function_privilege('authenticated','public.inbox_legacy_inventory(uuid)','EXECUTE')
    OR has_function_privilege('anon','public.inbox_legacy_inventory(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'inventory callable by browser'; END IF;
END $schema$;

DO $fixture$
DECLARE owner_a uuid := '00000000-0000-4000-8000-000000002051';
 owner_b uuid := '00000000-0000-4000-8000-000000002052';
 a uuid; b uuid; ca uuid; cb uuid; sa uuid; sb uuid; sd uuid; ma uuid; mb uuid; n bigint;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 (owner_a,'inbox205-a@example.test','{"full_name":"Inbox 205 A"}'),
 (owner_b,'inbox205-b@example.test','{"full_name":"Inbox 205 B"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=owner_a;
 SELECT account_id INTO STRICT b FROM public.profiles WHERE user_id=owner_b;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity)
 VALUES(a,'openwa','ready','inbox205-a','15550000111') RETURNING id INTO sa;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity)
 VALUES(a,'openwa','ready','inbox205-b','15550000111') RETURNING id INTO sb;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity)
 VALUES(b,'openwa','ready','inbox205-other','15550000111') RETURNING id INTO sd;
 INSERT INTO public.whatsapp_channels(account_id,provider,identity_key) VALUES(a,'openwa','e164:15550000111') RETURNING id INTO ca;
 INSERT INTO public.whatsapp_channels(account_id,provider,identity_key) VALUES(b,'openwa','e164:15550000111') RETURNING id INTO cb;
 BEGIN
  INSERT INTO public.whatsapp_channels(account_id,provider,identity_key) VALUES(a,'openwa','e164:15550000111');
  RAISE EXCEPTION 'duplicate verified identity accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 INSERT INTO public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,session_snapshot,evidence_kind,evidence_ref,verified_at,valid_from,is_primary)
 VALUES(a,'openwa',ca,sa,'inbox205-a','authenticated_openwa_status','fixture-a',now(),now(),true) RETURNING id INTO ma;
 INSERT INTO public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,session_snapshot,evidence_kind,evidence_ref,verified_at,valid_from)
 VALUES(a,'openwa',ca,sb,'inbox205-b','authenticated_openwa_status','fixture-b',now(),now()) RETURNING id INTO mb;
 BEGIN
  INSERT INTO public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,session_snapshot,evidence_kind,evidence_ref,verified_at,valid_from)
  VALUES(a,'openwa',ca,sd,'inbox205-other','authenticated_openwa_status','fixture-cross',now(),now());
  RAISE EXCEPTION 'cross-tenant membership accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE public.whatsapp_channel_memberships SET is_primary=true WHERE id=mb;
  RAISE EXCEPTION 'second primary accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE public.whatsapp_channel_memberships SET session_snapshot='mutated' WHERE id=ma;
  RAISE EXCEPTION 'identity epoch mutation accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.whatsapp_channel_memberships SET valid_until=now(),is_primary=false WHERE id=ma;
 BEGIN
  UPDATE public.whatsapp_channel_memberships SET valid_until=NULL WHERE id=ma;
  RAISE EXCEPTION 'closed epoch reopened';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.whatsapp_channel_memberships SET is_primary=true WHERE id=mb;
 SELECT count(*) INTO n FROM public.whatsapp_channel_memberships WHERE account_id=a AND channel_id=ca;
 IF n<>2 THEN RAISE EXCEPTION 'history not preserved'; END IF;
 SELECT source_messages INTO n FROM public.inbox_legacy_inventory(a);
 IF n<>0 THEN RAISE EXCEPTION 'unexpected fixture messages'; END IF;
END $fixture$;
ROLLBACK;
