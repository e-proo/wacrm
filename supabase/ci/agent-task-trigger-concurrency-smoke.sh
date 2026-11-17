#!/usr/bin/env bash
# Two real PostgreSQL connections: same-firing SKIP LOCKED and cap=1 insertion race.
# CI-only synthetic test.no_send trigger, no WhatsApp or agent runtime dispatch.
set -Eeuo pipefail
DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
tmp="$(mktemp -d)"
psqlq() { psql -X -qAt -v ON_ERROR_STOP=1 "$DB_URL" "$@"; }
cleanup() {
  local rc=$?
  set +e
  psqlq <<'SQL' >/dev/null
do $$
declare u uuid := '00000000-0000-4000-8000-000000000188';
        a uuid := '00000000-0000-4000-8000-000000000189';
        acct uuid;
begin
 select account_id into acct from public.profiles where user_id=u;
 if acct is not null then
  delete from public.ai_agent_task_trigger_firings where account_id=acct;
  delete from public.ai_agent_task_triggers where account_id=acct
    and idempotency_key='sch1-concurrent-ci-only-186';
  delete from public.ai_agents where id=a and account_id=acct;
  delete from public.profiles where user_id=u;
  delete from public.accounts where id=acct;
 end if;
 delete from auth.users where id=u;
end $$;
SQL
  rm -rf "$tmp"
  return "$rc"
}
trap cleanup EXIT

psqlq <<'SQL' >/dev/null
do $$
declare u uuid := '00000000-0000-4000-8000-000000000188';
        a uuid := '00000000-0000-4000-8000-000000000189';
        acct uuid;
        trg uuid;
begin
 if exists(select 1 from auth.users where id=u) then
  raise exception 'SCH1_RACE_FIXTURE_COLLISION';
 end if;
 insert into auth.users(id,email,raw_user_meta_data)
 values (u,'sch1-ci-concurrency@example.test','{"full_name":"SCH1 CI No Send"}'::jsonb);
 select account_id into strict acct from public.profiles where user_id=u;
 insert into public.ai_agents(id,account_id,slug,name,purpose,status)
 values (a,acct,'sch1-ci-no-send','SCH1 No Send','custom','active');
 trg:=public.create_agent_task_trigger(
  acct,'test.no_send',1,a,'schedule','once',now()+interval '1 day',
  null,null,null,'{}'::jsonb,'{}'::jsonb,'sch1-concurrent-ci-only-186',u
 );
 insert into public.ai_agent_task_trigger_firings(
  account_id,trigger_id,source_kind,source_key,scheduled_for,available_at
 ) values(acct,trg,'schedule','schedule:sch1-ci-race',
   now()-interval '1 minute',now()-interval '1 minute');
end $$;
SQL

wait_sleeping() {
  local app="$1"
  local active=''
  for _ in $(seq 1 80); do
    active="$(psqlq -c "select exists(select 1 from pg_stat_activity where application_name='$app' and wait_event='PgSleep')")"
    if [[ "$active" == "t" ]]; then return 0; fi
    sleep 0.1
  done
  echo "No overlapping PG session for $app" >&2
  return 1
}

PGAPPNAME=sch1-ci-claim-A psqlq -c "
with c as materialized (
 select public.claim_next_agent_task_trigger_firing('sch1-ci-claim-A',120) as payload
), hold as materialized (select pg_sleep(4) from c)
select coalesce(c.payload->>'firing_id','NONE') from c cross join hold
" > "$tmp/claimA" &
pid_a=$!
wait_sleeping sch1-ci-claim-A
PGAPPNAME=sch1-ci-claim-B psqlq -c "
select coalesce(public.claim_next_agent_task_trigger_firing(
 'sch1-ci-claim-B',120)->>'firing_id','NONE')
" > "$tmp/claimB"
wait "$pid_a"
[[ "$(cat "$tmp/claimA")" != "NONE" && "$(cat "$tmp/claimB")" == "NONE" ]] || {
 echo 'Double claim or missing claim under overlap' >&2
 exit 1
}
[[ "$(psqlq -c "
select count(*) from public.ai_agent_task_trigger_firings
where source_key='schedule:sch1-ci-race' and status='claimed'
and attempts=1 and lease_generation=1 and claimed_by like 'sch1-ci-claim-A:%'")" == '1' ]] || {
 echo 'Claim generation or attempts incorrect after race' >&2
 exit 1
}
echo 'PASS concurrent two-session claim: one owner only, other skipped locked row'

psqlq <<'SQL' >/dev/null
delete from public.ai_agent_task_trigger_firings
where source_key='schedule:sch1-ci-race';
insert into public.ai_runtime_policies(
 account_id, task_worker_enabled, agent_task_trigger_max_pending
) select account_id, true, 1 from public.ai_agent_task_triggers
where idempotency_key='sch1-concurrent-ci-only-186'
on conflict(account_id) do update
set task_worker_enabled=true,agent_task_trigger_max_pending=1;
SQL

PGAPPNAME=sch1-ci-cap-A psqlq -c "
with inserted as (
 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 select account_id,id,'schedule','schedule:sch1-ci-cap-A',
 now()-interval '1 minute',now()
 from public.ai_agent_task_triggers
 where idempotency_key='sch1-concurrent-ci-only-186'
 returning id
), hold as materialized (select pg_sleep(4) from inserted)
select id::text from inserted cross join hold
" > "$tmp/capA" &
pid_cap=$!
wait_sleeping sch1-ci-cap-A
PGAPPNAME=sch1-ci-cap-B psqlq -c "
with inserted as (
 insert into public.ai_agent_task_trigger_firings(
 account_id,trigger_id,source_kind,source_key,scheduled_for,available_at)
 select account_id,id,'schedule','schedule:sch1-ci-cap-B',
 now()-interval '1 minute',now()
 from public.ai_agent_task_triggers
 where idempotency_key='sch1-concurrent-ci-only-186'
 returning id
)
select coalesce((select id::text from inserted),'NONE')
" > "$tmp/capB"
wait "$pid_cap"
[[ -n "$(cat "$tmp/capA")" && "$(cat "$tmp/capB")" == 'NONE' ]] || {
 echo 'Concurrent cap=1 admitted a second pending firing' >&2
 exit 1
}
[[ "$(psqlq -c "
select count(*) from public.ai_agent_task_trigger_firings f
join public.ai_agent_task_triggers t on t.id=f.trigger_id
where t.idempotency_key='sch1-concurrent-ci-only-186'
and f.status in ('pending','claimed','failed')")" == '1' ]] || {
 echo 'Backlog overflow after concurrent admissions' >&2
 exit 1
}
echo 'PASS concurrent two-session pending admission: cap=1'
