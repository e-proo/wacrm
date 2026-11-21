#!/usr/bin/env bash
# Disposable clean replay CI only. Actual competing database connections.
set -euo pipefail
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
psqlq(){ psql "$DB" -X -q -v ON_ERROR_STOP=1 "$@"; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
psqlq <<'SQL'
DO $fixture$
DECLARE u uuid:='00000000-0000-4000-8000-000000002112'; a uuid; x uuid; ch uuid; ep uuid; d timestamptz; cv timestamptz; v jsonb; p uuid; c uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox211-race@example.test','{"full_name":"Inbox 211 race"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 FOR i IN 1..2 LOOP
  INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox211-race-'||i,'15550000152') RETURNING id,updated_at INTO x,d;
  INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,x,'openwa','https://example.test','fixture') RETURNING updated_at INTO cv;
  v=public.inbox_enroll_verified_channel(a,u,x,'openwa','15550000152','inbox211-race-'||i,NULL,d,cv,clock_timestamp(),'fixture-'||i,i=1);
  ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
  INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref) VALUES(a,'openwa',ch,x,ep,'fixture-race','fixture');
  INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,processing_token,processing_started_at)
    VALUES(a,x,'openwa','race-'||i,clock_timestamp(),gen_random_uuid(),clock_timestamp());
 END LOOP;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000212','Race') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
END $fixture$;
SQL
a=$(psqlq -Atc "SELECT account_id FROM public.profiles WHERE user_id='00000000-0000-4000-8000-000000002112'")
[[ "$a" =~ ^[0-9a-f-]{36}$ ]]
# Both workers use the same logical native identity, distinct signed receipts.
for i in 1 2; do
 psqlq -Atc "BEGIN; SELECT public.inbox_commit_canonical_inbound_context(r.account_id,r.connection_id,r.provider_event_id,r.processing_token,c.id,'inbox211-race-$i',NULL,'native-race',true,'text','body',NULL,NULL,clock_timestamp(),NULL,'{}',false,false) FROM public.whatsapp_webhook_event_receipts r JOIN public.conversations c ON c.account_id=r.account_id WHERE r.account_id='$a' AND r.provider_event_id='race-$i'; SELECT pg_sleep(0.35); COMMIT;" >"$work/$i" &
 if [[ "$i" = 1 ]]; then pid1=$!; else pid2=$!; fi
done
wait "$pid1"; wait "$pid2"
psqlq <<SQL
DO \$assert\$ DECLARE canonical uuid; primary_conn uuid; tok uuid; lease uuid; BEGIN
 SELECT id,origin_connection_id INTO STRICT canonical,primary_conn FROM public.inbox_canonical_messages WHERE account_id='$a';
 IF (SELECT count(*) FROM public.inbox_message_connection_observations WHERE canonical_id=canonical)<>2
 OR (SELECT count(*) FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.account_id='$a')<>1
 OR (SELECT sum(unread_count) FROM public.conversations WHERE account_id='$a')<>1
 OR NOT EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships WHERE account_id='$a' AND connection_id=primary_conn AND is_primary AND valid_until IS NULL)
 OR (SELECT count(*) FROM public.inbox_canonical_effects WHERE canonical_id=canonical AND state='pending')<>1 THEN RAISE EXCEPTION 'parallel canonical invariant'; END IF;
 SELECT processing_token INTO STRICT lease FROM public.whatsapp_webhook_event_receipts WHERE account_id='$a' AND connection_id=primary_conn AND provider_event_id='race-1';
 tok=public.inbox_claim_canonical_effect('$a',canonical,primary_conn,'race-1',lease);
 IF tok IS NULL OR public.inbox_claim_canonical_effect('$a',canonical,primary_conn,'race-1',lease) IS NOT NULL THEN RAISE EXCEPTION 'duplicate claim'; END IF;
END \$assert\$;
DELETE FROM public.inbox_canonical_intake_review WHERE account_id='$a';
DELETE FROM public.inbox_canonical_messages WHERE account_id='$a';
DELETE FROM public.messages WHERE conversation_id IN (SELECT id FROM public.conversations WHERE account_id='$a');
DELETE FROM public.conversations WHERE account_id='$a';
DELETE FROM public.inbox_native_namespace_proofs WHERE account_id='$a';
DELETE FROM public.whatsapp_channel_memberships WHERE account_id='$a';
DELETE FROM public.whatsapp_channels WHERE account_id='$a';
DELETE FROM public.whatsapp_webhook_event_receipts WHERE account_id='$a';
DELETE FROM public.whatsapp_connections WHERE account_id='$a';
DELETE FROM public.accounts WHERE id='$a';
DELETE FROM auth.users WHERE id='00000000-0000-4000-8000-000000002112';
SQL
echo 'INBOX concurrent canonical intake: PASS'
