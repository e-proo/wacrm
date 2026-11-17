-- SCH-1 / SOF-18: immutable approved policy per firing and explicit overlap outcomes.
-- Additive: preserve existing 124, 182-186 migrations and existing trigger/firing IDs.
alter table public.ai_agent_task_triggers
 add column if not exists policy_version integer not null default 1
 check (policy_version >= 1),
 add column if not exists approved_revision_id uuid,
 add column if not exists approved_by uuid,
 add column if not exists overlap_policy text not null default 'skip'
 check (overlap_policy in ('skip','defer'));

alter table public.ai_agent_task_trigger_firings
 add column if not exists policy_snapshot jsonb not null default '{}'::jsonb
 check (jsonb_typeof(policy_snapshot) = 'object'),
 add column if not exists skip_reason text;

alter table public.ai_agent_task_trigger_firings
 drop constraint if exists ai_agent_task_trigger_firings_status_check;
alter table public.ai_agent_task_trigger_firings
 add constraint ai_agent_task_trigger_firings_status_check
 check (status in ('pending','claimed','failed','completed','dead','skipped'));

-- One immutable, account-consistent snapshot for every newly materialized occurrence.
create or replace function public.freeze_agent_task_trigger_firing_policy()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare p public.ai_agent_task_triggers%rowtype;
begin
 select * into p from public.ai_agent_task_triggers
 where id=new.trigger_id and account_id=new.account_id;
 if not found then
  raise exception 'AGENT_TASK_TRIGGER_FIRING_ACCOUNT_MISMATCH';
 end if;
 new.policy_snapshot:=jsonb_build_object(
  'policy_version',p.policy_version,
  'approved_revision_id',p.approved_revision_id,
  'approved_by',p.approved_by,
  'overlap_policy',p.overlap_policy,
  'config',p.config,'filters',p.filters,'created_by',p.created_by
 );
 return new;
end;
$$;
revoke all on function public.freeze_agent_task_trigger_firing_policy() from public,anon,authenticated;
drop trigger if exists ai_agent_task_trigger_firing_policy_freeze
 on public.ai_agent_task_trigger_firings;
create trigger ai_agent_task_trigger_firing_policy_freeze
 before insert on public.ai_agent_task_trigger_firings
 for each row execute function public.freeze_agent_task_trigger_firing_policy();

create or replace function public.prevent_agent_task_firing_snapshot_rewrite()
returns trigger language plpgsql
set search_path=pg_catalog,public
as $$
begin
 if new.policy_snapshot is distinct from old.policy_snapshot then
  raise exception 'AGENT_TASK_FIRING_POLICY_IMMUTABLE';
 end if;
 return new;
end;
$$;
revoke all on function public.prevent_agent_task_firing_snapshot_rewrite() from public,anon,authenticated;
drop trigger if exists ai_agent_task_firing_policy_immutable
 on public.ai_agent_task_trigger_firings;
create trigger ai_agent_task_firing_policy_immutable
 before update of policy_snapshot on public.ai_agent_task_trigger_firings
 for each row execute function public.prevent_agent_task_firing_snapshot_rewrite();

-- Create reviewed policies via existing create RPC in one database transaction.
-- Idempotency keys cannot silently change immutable approval or schedule settings.
create or replace function public.create_reviewed_agent_task_trigger(
 p_account_id uuid,p_task_type text,p_task_type_version integer,p_agent_id uuid,
 p_trigger_kind text,p_schedule_kind text,p_next_fire_at timestamptz,
 p_interval_minutes integer,p_event_type text,p_event_version integer,
 p_config jsonb,p_filters jsonb,p_idempotency_key text,p_actor uuid,
 p_approved_revision_id uuid,p_overlap_policy text
) returns uuid language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_existing public.ai_agent_task_triggers%rowtype;
        v_id uuid;
begin
 if p_overlap_policy not in ('skip','defer') or p_overlap_policy is null then
  raise exception 'AGENT_TASK_TRIGGER_OVERLAP_POLICY_INVALID';
 end if;
 if p_actor is null or not exists(
  select 1 from public.profiles as p
  where p.user_id=p_actor and p.account_id=p_account_id
    and p.account_role in ('owner','admin')
 ) then
  raise exception 'AGENT_TASK_TRIGGER_APPROVER_UNAUTHORIZED';
 end if;
 if not exists(
   select 1 from public.ai_agents as a
   join public.ai_agent_revisions as rev
    on rev.id=a.published_revision_id
   and rev.agent_id=a.id and rev.account_id=a.account_id
   where a.account_id=p_account_id and a.id=p_agent_id
    and a.status='active' and rev.status='published'
    and rev.id=p_approved_revision_id
 ) then
  raise exception 'AGENT_TASK_TRIGGER_REVISION_NOT_PUBLISHED';
 end if;

 select * into v_existing from public.ai_agent_task_triggers
 where account_id=p_account_id and idempotency_key=btrim(p_idempotency_key)
 for update;
 if found then
  if v_existing.approved_revision_id is distinct from p_approved_revision_id
     or v_existing.approved_by is distinct from p_actor
     or v_existing.overlap_policy is distinct from p_overlap_policy
     or v_existing.task_type is distinct from p_task_type
     or v_existing.task_type_version is distinct from p_task_type_version
     or v_existing.agent_id is distinct from p_agent_id
     or v_existing.trigger_kind is distinct from p_trigger_kind
     or v_existing.schedule_kind is distinct from p_schedule_kind
     or v_existing.interval_minutes is distinct from p_interval_minutes
     or v_existing.next_fire_at is distinct from p_next_fire_at
     or v_existing.event_type is distinct from p_event_type
     or v_existing.event_version is distinct from p_event_version
     or v_existing.config is distinct from p_config
     or v_existing.filters is distinct from p_filters then
    raise exception 'AGENT_TASK_TRIGGER_IDEMPOTENCY_POLICY_CONFLICT';
  end if;
  return v_existing.id;
 end if;
 v_id:=public.create_agent_task_trigger(
  p_account_id,p_task_type,p_task_type_version,p_agent_id,p_trigger_kind,
  p_schedule_kind,p_next_fire_at,p_interval_minutes,p_event_type,p_event_version,
  p_config,p_filters,p_idempotency_key,p_actor
 );
 update public.ai_agent_task_triggers
 set approved_revision_id=p_approved_revision_id,
     approved_by=p_actor,overlap_policy=p_overlap_policy,
     status='paused',updated_at=now()
 where id=v_id and account_id=p_account_id
   and approved_revision_id is null
   and not exists(select 1 from public.ai_agent_task_trigger_firings
                  where trigger_id=v_id);
 if not found then
  raise exception 'AGENT_TASK_TRIGGER_REVIEW_CONFLICT';
 end if;
 return v_id;
end;
$$;
revoke all on function public.create_reviewed_agent_task_trigger(
 uuid,text,integer,uuid,text,text,timestamptz,integer,text,integer,
 jsonb,jsonb,text,uuid,uuid,text
) from public,anon,authenticated;
grant execute on function public.create_reviewed_agent_task_trigger(
 uuid,text,integer,uuid,text,text,timestamptz,integer,text,integer,
 jsonb,jsonb,text,uuid,uuid,text
) to service_role;

-- Overlap is a durable firing outcome; never claim a newly created Task.
create or replace function public.skip_agent_task_trigger_firing(
 p_firing_id uuid,p_worker_id text,p_reason text
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public
as $$
begin
 if coalesce(length(btrim(p_reason)),0)<1 or length(p_reason)>256 then
  raise exception 'AGENT_TASK_TRIGGER_SKIP_REASON_INVALID';
 end if;
 update public.ai_agent_task_trigger_firings
 set status='skipped',skip_reason=p_reason,claimed_by=null,lease_expires_at=null,
     last_error=null,updated_at=now()
 where id=p_firing_id and status='claimed' and claimed_by=p_worker_id
   and lease_expires_at>now();
 return found;
end;
$$;
revoke all on function public.skip_agent_task_trigger_firing(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.skip_agent_task_trigger_firing(uuid,text,text) to service_role;

-- Defer busy subjects WITHOUT consuming a technical retry attempt.
create or replace function public.defer_agent_task_trigger_firing(
 p_firing_id uuid,p_worker_id text,p_reason text,p_delay_secs integer default 300
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public
as $$
begin
 if p_delay_secs < 60 or p_delay_secs > 86400 or p_delay_secs is null then
  raise exception 'AGENT_TASK_TRIGGER_DEFER_DELAY_INVALID';
 end if;
 if coalesce(length(btrim(p_reason)),0)<1 or length(p_reason)>256 then
  raise exception 'AGENT_TASK_TRIGGER_DEFER_REASON_INVALID';
 end if;
 update public.ai_agent_task_trigger_firings
 set status='pending',attempts=greatest(0,attempts-1),claimed_by=null,
     lease_expires_at=null,available_at=now()+make_interval(secs=>p_delay_secs),
     last_error=p_reason,updated_at=now()
 where id=p_firing_id and status='claimed' and claimed_by=p_worker_id
   and lease_expires_at>now();
 return found;
end;
$$;
revoke all on function public.defer_agent_task_trigger_firing(uuid,text,text,integer)
 from public,anon,authenticated;
grant execute on function public.defer_agent_task_trigger_firing(uuid,text,text,integer) to service_role;

create or replace function public.claim_next_agent_task_trigger_firing(
  p_worker_id text,
  p_lease_secs integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_firing_id uuid;
  v_account_id uuid;
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if length(p_worker_id) > 128 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_TOO_LONG';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id, firing.account_id
    into v_firing_id, v_account_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.ai_agent_task_trigger_claim_fairness as fairness
    on fairness.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = firing.account_id
    ), true)
    and (
      (
        firing.status in ('pending', 'failed')
        and firing.available_at <= pg_catalog.now()
      )
      or
      (
        firing.status = 'claimed'
        and firing.lease_expires_at is not null
        and firing.lease_expires_at <= pg_catalog.now()
      )
    )
    and firing.attempts < 5
  order by coalesce(fairness.last_claimed_at, '-infinity'::timestamptz) asc,
    firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         lease_generation = lease_generation + 1,
         claimed_by = btrim(p_worker_id) || ':' || pg_catalog.gen_random_uuid()::text,
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

  insert into public.ai_agent_task_trigger_claim_fairness(account_id,last_claimed_at)
  values (v_account_id,pg_catalog.clock_timestamp())
  on conflict(account_id) do update
    set last_claimed_at = excluded.last_claimed_at;

  select jsonb_build_object(
    'firing_id', firing.id,
    'account_id', firing.account_id,
    'trigger_id', trigger.id,
    'task_type', trigger.task_type,
    'task_type_version', trigger.task_type_version,
    'agent_id', trigger.agent_id,
    'trigger_kind', trigger.trigger_kind,
    -- Config/filters and review binding are frozen when the firing is inserted.
    'config', coalesce(firing.policy_snapshot -> 'config', trigger.config),
    'filters', coalesce(firing.policy_snapshot -> 'filters', trigger.filters),
    'created_by', coalesce((firing.policy_snapshot ->> 'created_by'), trigger.created_by::text),
    'policy_version', coalesce((firing.policy_snapshot ->> 'policy_version')::integer, trigger.policy_version),
    'overlap_policy', coalesce(firing.policy_snapshot ->> 'overlap_policy', trigger.overlap_policy),
    'approved_revision_id', coalesce(firing.policy_snapshot ->> 'approved_revision_id', trigger.approved_revision_id::text),
    'source_key', firing.source_key,
    'scheduled_for', firing.scheduled_for,
    'attempts', firing.attempts,
    'claim_owner', firing.claimed_by,
    'lease_generation', firing.lease_generation,
    'business_event',
      case
        when event.id is null then null
        else jsonb_build_object(
          'id', event.id,
          'event_type', event.event_type,
          'event_version', event.event_version,
          'subject_type', event.subject_type,
          'subject_id', event.subject_id,
          'correlation_id', event.correlation_id,
          'causation_id', event.causation_id,
          'payload', event.payload,
          'created_at', event.created_at
        )
      end
  )
    into v_result
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.business_event_outbox as event
    on event.id = firing.business_event_id
   and event.account_id = firing.account_id
  where firing.id = v_firing_id;

  return v_result;
end;
$$;

revoke all on function public.claim_next_agent_task_trigger_firing(text,integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task_trigger_firing(text,integer)
  to service_role;


