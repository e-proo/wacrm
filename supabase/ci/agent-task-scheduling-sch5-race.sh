#!/usr/bin/env bash
# SCH-5. Two REAL PostgreSQL sessions prove the shared SCH-4 tick lease
# serializes concurrent invocations and fences a crashed/stale owner.
# CI isolated database ONLY. No Task creation or WhatsApp adapter execution.
set -Eeuo pipefail
DB_URL="${SCH5_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
tmp="$(mktemp -d)"
sql() { psql -X -qAt -v ON_ERROR_STOP=1 "$DB_URL" "$@"; }
cleanup() {
  local code=$?
  set +e
  sql -c "delete from public.ai_agent_task_scheduler_heartbeat where runner='test_agent_task'" >/dev/null
  rm -rf "$tmp"
  return "$code"
}
trap cleanup EXIT
# Reset after the transactional migration smoke, which rolls back its changes.
[[ "$(sql -c "select count(*) from public.ai_agent_task_scheduler_heartbeat")" == "0" ]] || {
  echo 'SCH5_HEARTBEAT_FIXTURE_COLLISION' >&2
  exit 1
}
owner_a='00000000-0000-4000-8000-000000000197'
owner_b='00000000-0000-4000-8000-000000000198'
owner_c='00000000-0000-4000-8000-000000000199'

# Session A has not committed its heartbeat INSERT, while B races to acquire.
# pg_stat_activity proves actual overlap rather than just concurrent JS calls.
PGAPPNAME=sch5-real-lease-A sql -c "
with claim as materialized (
  select public.begin_agent_task_scheduler_tick('$owner_a'::uuid,120) as ok
), hold as materialized (select pg_sleep(3) from claim)
select case when claim.ok then 'OWNER_A' else 'NONE' end
from claim cross join hold
" > "$tmp/a" &
pid_a=$!
found=0
for _ in $(seq 1 90); do
  if [[ "$(sql -c "select exists(select 1 from pg_stat_activity where application_name='sch5-real-lease-A' and wait_event='PgSleep')")" == "t" ]]; then
    found=1
    break
  fi
  sleep 0.1
done
[[ "$found" == "1" ]] || { echo 'SCH5_NO_ACTUAL_OVERLAP' >&2; exit 1; }
PGAPPNAME=sch5-real-lease-B sql -c "
select case when public.begin_agent_task_scheduler_tick('$owner_b'::uuid,120)
  then 'OWNER_B' else 'BUSY' end
" > "$tmp/b"
wait "$pid_a"
[[ "$(cat "$tmp/a")" == 'OWNER_A' &&
   "$(cat "$tmp/b")" == 'BUSY' ]] || {
  echo 'SCH5_DOUBLE_TICK_LEASE' >&2
  exit 1
}
[[ "$(sql -c "select count(*) from public.ai_agent_task_scheduler_heartbeat where lease_owner='$owner_a'::uuid")" == "1" ]] || {
  echo 'SCH5_OWNER_DIVERGENCE' >&2
  exit 1
}
echo 'PASS SCH5 real parallel tick race: only one owner, other busy'

[[ "$(sql -c "select public.finish_agent_task_scheduler_tick('$owner_a'::uuid,true,2,1,1,0)")" == 't' ]] || {
  echo 'SCH5_FINISH_A_FAILED' >&2
  exit 1
}
[[ "$(sql -c "select public.begin_agent_task_scheduler_tick('$owner_b'::uuid,120)")" == 't' ]] || {
  echo 'SCH5_NO_RECOVERY_AFTER_FINISH' >&2
  exit 1
}
# Simulate process death/expired lease without waiting 120 real seconds.
sql -c "update public.ai_agent_task_scheduler_heartbeat
         set lease_expires_at=now()-interval '1 second'
         where lease_owner='$owner_b'::uuid" >/dev/null
[[ "$(sql -c "select public.begin_agent_task_scheduler_tick('$owner_c'::uuid,120)")" == 't' ]] || {
  echo 'SCH5_EXPIRED_LEASE_NOT_RECLAIMED' >&2
  exit 1
}
[[ "$(sql -c "select public.finish_agent_task_scheduler_tick('$owner_b'::uuid,true,0,0,0,0)")" == 'f' ]] || {
  echo 'SCH5_STALE_OWNER_FINISHED_AFTER_RECLAIM' >&2
  exit 1
}
[[ "$(sql -c "select public.finish_agent_task_scheduler_tick('$owner_c'::uuid,false,0,0,0,1)")" == 't' ]] || {
  echo 'SCH5_RECOVERY_OWNER_COULD_NOT_FINISH' >&2
  exit 1
}
[[ "$(sql -c "select count(*) from public.ai_agent_task_scheduler_heartbeat
where runner='test_agent_task' and lease_owner is null
and tick_count=2 and consecutive_failures=1
and last_result='failed' and last_dead=1")" == '1' ]] || {
  echo 'SCH5_FAILURE_HEARTBEAT_INCORRECT' >&2
  exit 1
}
echo 'PASS SCH5 crash-reclaim: stale owner fenced, recovered owner counted once'
