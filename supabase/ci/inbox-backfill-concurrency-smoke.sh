#!/usr/bin/env bash
# Disposable clean-CI database only. Two real connections contend on bounded backfill.
set -euo pipefail
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
psqlq() { psql "$DB" -X -q -v ON_ERROR_STOP=1 "$@"; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
psqlq <<'SQL'
DO $fixture$
DECLARE u uuid:='00000000-0000-4000-8000-000000002074'; a uuid; s uuid; ch uuid; ep uuid; p uuid; c uuid; m uuid; d timestamptz; cv timestamptz; v jsonb; i int; native text;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,'inbox207-race@example.test','{"full_name":"Inbox race"}');
 SELECT account_id INTO STRICT a FROM public.profiles WHERE user_id=u;
 INSERT INTO public.whatsapp_connections(account_id,provider,status,session_id,phone_identity) VALUES(a,'openwa','ready','inbox207-race','15550000113') RETURNING id,updated_at INTO s,d;
 INSERT INTO public.whatsapp_connection_credentials(account_id,connection_id,provider,base_url,api_key_encrypted) VALUES(a,s,'openwa','https://example.test','synthetic') RETURNING updated_at INTO cv;
 v=public.inbox_enroll_verified_channel(a,u,s,'openwa','15550000113','inbox207-race',NULL,d,cv,clock_timestamp(),'race-proof',true);
 ch=(v->>'channel_id')::uuid;ep=(v->>'membership_id')::uuid;
 INSERT INTO public.contacts(user_id,account_id,phone,name) VALUES(u,a,'+15550000206','Race') RETURNING id INTO p;
 INSERT INTO public.conversations(user_id,account_id,contact_id) VALUES(u,a,p) RETURNING id INTO c;
 FOR i IN 1..2 LOOP
  native='207-race-'||i;
  INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,status,provider,connection_id,provider_message_id,message_id,created_at)
  VALUES(c,'customer','text',native,'delivered','openwa',s,native,native,clock_timestamp()) RETURNING id INTO m;
  INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
  VALUES(m,a,c,'openwa',ch,s,ep,native,clock_timestamp(),native);
 END LOOP;
END $fixture$;
SQL
a=$(psqlq -Atc "SELECT account_id FROM public.profiles WHERE user_id='00000000-0000-4000-8000-000000002074'")
[[ "$a" =~ ^[0-9a-f-]{36}$ ]]
# First worker holds the account fence while second waits.
psqlq -Atc "BEGIN; SELECT public.inbox_backfill_verified_messages('$a',1); SELECT pg_sleep(0.5); COMMIT;" >"$work/a" &
pid_a=$!
psqlq -Atc "BEGIN; SELECT public.inbox_backfill_verified_messages('$a',1); COMMIT;" >"$work/b" &
pid_b=$!
wait "$pid_a"; wait "$pid_b"
grep -qx 1 "$work/a"; grep -qx 1 "$work/b"
psqlq <<SQL
DO \$assert\$ BEGIN
 IF (SELECT count(*) FROM public.inbox_message_memberships WHERE account_id='$a')<>2
 OR (SELECT count(*) FROM public.inbox_threads WHERE account_id='$a')<>1
 OR NOT EXISTS(SELECT 1 FROM public.inbox_threads WHERE account_id='$a' AND ingest_highwater=2 AND unread_count_known=0 AND last_trusted_inbound_at IS NULL)
 OR public.inbox_backfill_verified_messages('$a',100)<>0 THEN RAISE EXCEPTION 'parallel backfill invariant'; END IF;
END \$assert\$;
-- Explicit ordered cleanup; account removal is not the scenario under test.
DELETE FROM public.messages WHERE conversation_id IN(SELECT id FROM public.conversations WHERE account_id='$a');
DELETE FROM public.conversations WHERE account_id='$a';
DELETE FROM public.whatsapp_channel_memberships WHERE account_id='$a';
DELETE FROM public.whatsapp_channels WHERE account_id='$a';
DELETE FROM public.whatsapp_connections WHERE account_id='$a';
DELETE FROM public.accounts WHERE id='$a';
DELETE FROM auth.users WHERE id='00000000-0000-4000-8000-000000002074';
SQL
echo 'INBOX parallel backfill: PASS'
