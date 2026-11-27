BEGIN;
DO $test$
DECLARE u uuid:='00000000-0000-4000-8000-000000002301';v uuid:='00000000-0000-4000-8000-000000002302';a uuid;c uuid;r uuid;r2 uuid;tok uuid:=gen_random_uuid();cv timestamptz;result text;j jsonb;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'intake230@example.test','{"full_name":"Intake230"}'),(v,'intake230other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','intake230','15550000230') RETURNING id INTO c;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted,webhook_secret_encrypted) VALUES(a,c,'openwa','https://fixture.example','fixture','fixture') RETURNING updated_at INTO cv;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_started_at,processing_token,processing_attempts,processing_error)
 VALUES(a,c,'openwa','old',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days',tok,2,'processing_failed') RETURNING id INTO r;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,processing_started_at,processing_token,processing_attempts)
 VALUES(a,c,'openwa','recent',clock_timestamp(),gen_random_uuid(),1) RETURNING id INTO r2;
 BEGIN PERFORM public.openwa_intake_close_unverified(a,v,r);RAISE EXCEPTION 'foreign closure';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 EXECUTE 'SET LOCAL ROLE service_role';
 j=public.openwa_intake_review_page(a,u,NULL,20);
 IF jsonb_array_length(j->'rows')<>2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'id'=r::text AND x->>'reason'='legacy_payload_missing' AND x->>'can_close'='true')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'id'=r2::text AND x->>'can_close'='false') THEN RAISE EXCEPTION 'legacy projection %',j; END IF;
 IF public.openwa_intake_close_unverified(a,u,r2)<>'conflict' THEN RAISE EXCEPTION 'live lease closed'; END IF;
 result=public.openwa_intake_close_unverified(a,u,r);
 IF result<>'closed_unverified' THEN RAISE EXCEPTION 'legacy closure %',result; END IF;
 IF public.openwa_intake_close_unverified(a,u,r)<>'closed_unverified' THEN RAISE EXCEPTION 'closure retry'; END IF;
 IF public.openwa_enqueue_signed_intake(a,c,'old','intake230',NULL,cv,false,repeat('a',64),repeat('a',100))<>'closed_unverified_duplicate' THEN RAISE EXCEPTION 'closed receipt adopted'; END IF;
 BEGIN UPDATE public.whatsapp_webhook_event_receipts SET processing_token=gen_random_uuid(),processing_started_at=clock_timestamp() WHERE id=r;RAISE EXCEPTION 'old retry reopened';EXCEPTION WHEN lock_not_available THEN NULL;END;
 j=public.openwa_intake_health(a,u,false);
 EXECUTE 'RESET ROLE';
 IF (j->>'legacy_unfinished')::int<>1 OR (j->>'legacy_closed')::int<>1 THEN RAISE EXCEPTION 'health %',j; END IF;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at)
 VALUES(a,c,'openwa','linked-old',clock_timestamp()-interval '2 days') RETURNING id INTO r2;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload) VALUES(r2,a,c,'openwa','namespace_unverified','{}');
 j=public.openwa_intake_review_page(a,u,NULL,20);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'id'=r2::text AND x->>'can_close'='false') THEN RAISE EXCEPTION 'linked receipt advertised as eligible'; END IF;
 IF public.openwa_intake_close_unverified(a,u,r2)<>'conflict' THEN RAISE EXCEPTION 'linked receipt closed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts WHERE id=r AND legacy_closed_by=u AND processed_at IS NULL AND processing_token=tok AND processing_attempts=2 AND processing_error='processing_failed') THEN RAISE EXCEPTION 'original evidence lost'; END IF;
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
