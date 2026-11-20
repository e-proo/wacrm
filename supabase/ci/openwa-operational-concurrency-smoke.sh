#!/usr/bin/env bash
# OW14-W07-07: real parallel SQL clients against a CLEAN LOCAL database only.
# Host and port are pinned: NEVER run this against hosted TEST or Production.
set -euo pipefail
DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
psql_cmd() { psql "$DB" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
OWNER="$(psql_cmd -c 'SELECT gen_random_uuid()')"
CONNECTION="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ1="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ2="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ3="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ4="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ5="$(psql_cmd -c 'SELECT gen_random_uuid()')"
REQ6="$(psql_cmd -c 'SELECT gen_random_uuid()')"
VERSION="w07-race-$OWNER"
WORK="$(mktemp -d)"
ACCOUNT=""
cleanup() {
  if [[ -n "$ACCOUNT" ]]; then
    psql_cmd -c "DELETE FROM public.whatsapp_openwa_activation_state WHERE account_id='$ACCOUNT'::uuid;
DELETE FROM public.whatsapp_openwa_activation_audit WHERE account_id='$ACCOUNT'::uuid;
DELETE FROM public.whatsapp_openwa_consent_state WHERE account_id='$ACCOUNT'::uuid;
DELETE FROM public.whatsapp_openwa_consent_audit WHERE account_id='$ACCOUNT'::uuid;
DELETE FROM public.whatsapp_connections WHERE id='$CONNECTION'::uuid;
DELETE FROM public.whatsapp_openwa_policy_versions WHERE version='$VERSION';
DELETE FROM auth.users WHERE id='$OWNER'::uuid;" >/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# A local Supabase signup trigger creates a scoped account profile.
psql_cmd -c "INSERT INTO auth.users(id,email,raw_user_meta_data)
VALUES ('$OWNER'::uuid,'w07-race-$OWNER@example.test','{}'::jsonb)" >/dev/null
ACCOUNT="$(psql_cmd -c "SELECT account_id FROM public.profiles WHERE user_id='$OWNER'::uuid")"
if [[ ! "$ACCOUNT" =~ ^[a-f0-9-]{36}$ ]]; then
  echo 'W07 race fixture has no account' >&2; exit 1
fi
psql_cmd -c "INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id)
VALUES ('$CONNECTION'::uuid,'$ACCOUNT'::uuid,'openwa','ready','w07-ci-race-session');
INSERT INTO public.whatsapp_openwa_policy_versions(version,digest,approved_at,approval_ref,is_current)
VALUES ('$VERSION',repeat('b',64),clock_timestamp(),'W07-CI-local-rollback-only',true);" >/dev/null
consent() {
  local action="$1" rev="$2" request="$3" output="$4"
  local version_sql="NULL" digest_sql="NULL"
  if [[ "$action" == "accept" ]]; then
    version_sql="'$VERSION'"
    digest_sql="repeat('b',64)"
  fi
  psql_cmd -c "SET ROLE service_role;
SELECT public.set_openwa_operational_consent(
'$ACCOUNT'::uuid,'$OWNER'::uuid,'$action',
$version_sql,$digest_sql,$rev,'$request'::uuid);" >"$output"
}
activation() {
  local status="$1" rev="$2" request="$3" output="$4"
  psql_cmd -c "SET ROLE service_role;
SELECT public.set_openwa_operational_activation(
'$ACCOUNT'::uuid,'$CONNECTION'::uuid,'$OWNER'::uuid,
'$status',$rev,'$request'::uuid);" >"$output"
}
assert_one_success_one_conflict() {
  local first="$1" second="$2"
  local wins=0 conflicts=0
  for f in "$first" "$second"; do
    if grep -Eq '"updated": true' "$f"; then wins=$((wins+1)); fi
    if grep -Eq '"reason": "revision_conflict"' "$f"; then conflicts=$((conflicts+1)); fi
  done
  if [[ "$wins" -ne 1 || "$conflicts" -ne 1 ]]; then
    echo 'W07 CAS race failed: expected one update and one revision conflict' >&2
    cat "$first" "$second" >&2; exit 1
  fi
}
consent accept 0 "$REQ1" "$WORK/accept1" &
p1=$!
consent accept 0 "$REQ2" "$WORK/accept2" &
p2=$!
wait "$p1"; wait "$p2"
assert_one_success_one_conflict "$WORK/accept1" "$WORK/accept2"
[[ "$(psql_cmd -c "SELECT revision FROM public.whatsapp_openwa_consent_state WHERE account_id='$ACCOUNT'::uuid")" == "1" ]]
[[ "$(psql_cmd -c "SELECT count(*) FROM public.whatsapp_openwa_consent_audit WHERE account_id='$ACCOUNT'::uuid")" == "1" ]]
activation enabled 0 "$REQ3" "$WORK/activate1" &
p1=$!
activation suspended 0 "$REQ4" "$WORK/activate2" &
p2=$!
wait "$p1"; wait "$p2"
assert_one_success_one_conflict "$WORK/activate1" "$WORK/activate2"
[[ "$(psql_cmd -c "SELECT revision FROM public.whatsapp_openwa_activation_state WHERE account_id='$ACCOUNT'::uuid AND connection_id='$CONNECTION'::uuid")" == "1" ]]
[[ "$(psql_cmd -c "SELECT count(*) FROM public.whatsapp_openwa_activation_audit WHERE account_id='$ACCOUNT'::uuid")" == "1" ]]
# Revocation and enable may race. Regardless of ordering, final admission
# based on SAME accepted event and current status MUST be false.
consent revoke 1 "$REQ5" "$WORK/revoke" &
p1=$!
activation enabled 1 "$REQ6" "$WORK/activate-after" &
p2=$!
wait "$p1"; wait "$p2"
grep -Eq '"updated": true' "$WORK/revoke"
[[ "$(psql_cmd -c "SELECT status FROM public.whatsapp_openwa_consent_state WHERE account_id='$ACCOUNT'::uuid")" == "revoked" ]]
GATED="$(psql_cmd -c "SELECT count(*) FROM public.whatsapp_openwa_activation_state a
JOIN public.whatsapp_openwa_consent_state c ON c.account_id=a.account_id
WHERE a.account_id='$ACCOUNT'::uuid AND a.connection_id='$CONNECTION'::uuid
AND a.status='enabled' AND c.status='accepted' AND a.consent_event_id=c.accepted_event_id")"
[[ "$GATED" == "0" ]] || { echo 'Revocation race retained effective activation' >&2; exit 1; }
echo 'W07 local SQL races verified: consent CAS, activation CAS, revoke/enable fence'
