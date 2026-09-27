-- ============================================================
-- 112_ai_agent_outbound_messaging_policy.sql
-- Durable Agent Task outbound reservation + WhatsApp policy guard.
--
-- Does not modify the existing Intents/Business Event cutover routes.
-- Does not call Meta. Transport is invoked only after a durable reservation.
-- ============================================================

create table if not exists public.ai_agent_task_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_id uuid not null,
  task_target_id uuid not null,
  run_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  policy_key text not null check (length(btrim(policy_key)) > 0),
  policy_version integer not null check (policy_version > 0),
  message_kind text not null check (message_kind in ('text','template')),
  candidate_text text,
  template_name text,
  template_language text,
  template_params jsonb not null default '[]'::jsonb,
  session_window_active boolean not null,
  session_last_inbound_at timestamptz,
  status text not null default 'reserved'
    check (status in (
      'reserved',
      'sending',
      'sent',
      'requires_reconciliation',
      'failed',
      'cancelled'
    )),
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claimed_by text,
  local_message_id uuid references public.messages(id) on delete restrict,
  whatsapp_message_id text,
  error_code text,
  error_detail text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_task_outbound_account_task_fk
    foreign key (account_id, task_id)
    references public.ai_agent_tasks(account_id, id)
    on delete restrict,
  constraint ai_agent_task_outbound_account_target_fk
    foreign key (account_id, task_id, task_target_id)
    references public.ai_agent_task_targets(account_id, task_id, id)
    on delete restrict,
  constraint ai_agent_task_outbound_account_run_fk
    foreign key (account_id, task_id, run_id)
    references public.ai_agent_runs(account_id, task_id, id)
    on delete restrict,
  constraint ai_agent_task_outbound_kind_shape_check
    check (
      (
        message_kind='text'
        and candidate_text is not null
        and length(btrim(candidate_text)) > 0
        and template_name is null
        and template_language is null
      )
      or
      (
        message_kind='template'
        and template_name is not null
        and length(btrim(template_name)) > 0
        and template_language is not null
        and length(btrim(template_language)) > 0
      )
    ),
  constraint ai_agent_task_outbound_template_params_array_check
    check (jsonb_typeof(template_params)='array')
);

create unique index if not exists ai_agent_task_outbound_idempotency_uidx
  on public.ai_agent_task_outbound_messages (idempotency_key);

create unique index if not exists ai_agent_task_outbound_run_uidx
  on public.ai_agent_task_outbound_messages (run_id);

create index if not exists ai_agent_task_outbound_due_idx
  on public.ai_agent_task_outbound_messages (available_at, created_at)
  where status='reserved';

create index if not exists ai_agent_task_outbound_reconciliation_idx
  on public.ai_agent_task_outbound_messages (account_id, status, created_at)
  where status='requires_reconciliation';

alter table public.ai_agent_task_outbound_messages enable row level security;

drop policy if exists ai_agent_task_outbound_messages_select
  on public.ai_agent_task_outbound_messages;
create policy ai_agent_task_outbound_messages_select
  on public.ai_agent_task_outbound_messages
  for select
  using (is_account_member(account_id));

revoke all on table public.ai_agent_task_outbound_messages
  from anon, authenticated;
grant select on table public.ai_agent_task_outbound_messages
  to authenticated;
grant all on table public.ai_agent_task_outbound_messages
  to service_role;

create or replace function public.update_ai_agent_task_outbound_messages_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

drop trigger if exists ai_agent_task_outbound_messages_updated_at
  on public.ai_agent_task_outbound_messages;
create trigger ai_agent_task_outbound_messages_updated_at
  before update on public.ai_agent_task_outbound_messages
  for each row
  execute function public.update_ai_agent_task_outbound_messages_updated_at();

create or replace function public.reserve_agent_task_outbound_message(
  p_run_id uuid,
  p_policy_key text,
  p_policy_version integer,
  p_message_kind text,
  p_candidate_text text,
  p_template_name text,
  p_template_language text,
  p_template_params jsonb,
  p_max_followups integer,
  p_minimum_interval_minutes integer,
  p_maximum_interval_minutes integer,
  p_stop_on_reply boolean
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_existing public.ai_agent_task_outbound_messages%rowtype;
  v_last_inbound_at timestamptz;
  v_session_active boolean;
  v_last_sent_at timestamptz;
  v_followup_number integer;
  v_reservation_id uuid;
  v_idempotency_key text;
  v_params jsonb:=coalesce(p_template_params,'[]'::jsonb);
begin
  if length(btrim(coalesce(p_policy_key,'')))=0 then
    raise exception 'AGENT_OUTBOUND_POLICY_KEY_REQUIRED';
  end if;
  if p_policy_version is null or p_policy_version<1 then
    raise exception 'AGENT_OUTBOUND_POLICY_VERSION_INVALID';
  end if;
  if p_message_kind not in ('text','template') then
    raise exception 'AGENT_OUTBOUND_MESSAGE_KIND_INVALID';
  end if;
  if p_max_followups is null or p_max_followups<0 or p_max_followups>100 then
    raise exception 'AGENT_OUTBOUND_MAX_FOLLOWUPS_INVALID';
  end if;
  if p_minimum_interval_minutes is null
     or p_minimum_interval_minutes<0
     or p_maximum_interval_minutes is null
     or p_maximum_interval_minutes<p_minimum_interval_minutes
     or p_maximum_interval_minutes>525600 then
    raise exception 'AGENT_OUTBOUND_FOLLOWUP_INTERVAL_INVALID';
  end if;
  if jsonb_typeof(v_params)<>'array' then
    raise exception 'AGENT_OUTBOUND_TEMPLATE_PARAMS_INVALID';
  end if;

  select * into v_run
  from public.ai_agent_runs
  where id=p_run_id
  for update;

  if v_run.id is null
     or v_run.run_mode<>'outbound'
     or v_run.task_id is null
     or v_run.task_target_id is null then
    return jsonb_build_object('reserved',false,'reason','run_not_outbound');
  end if;

  select * into v_task
  from public.ai_agent_tasks
  where id=v_run.task_id
    and account_id=v_run.account_id
  for update;

  if v_task.id is null or v_task.status<>'running' then
    return jsonb_build_object('reserved',false,'reason','task_not_running');
  end if;

  select * into v_target
  from public.ai_agent_task_targets
  where id=v_run.task_target_id
    and account_id=v_run.account_id
    and task_id=v_run.task_id
  for update;

  if v_target.id is null or v_target.status<>'in_progress' then
    return jsonb_build_object('reserved',false,'reason','target_not_in_progress');
  end if;

  select * into v_existing
  from public.ai_agent_task_outbound_messages
  where run_id=v_run.id
  limit 1;

  if v_existing.id is not null then
    return jsonb_build_object(
      'reserved',true,
      'reason','existing',
      'reservation_id',v_existing.id,
      'status',v_existing.status,
      'message_kind',v_existing.message_kind,
      'session_window_active',v_existing.session_window_active
    );
  end if;

  if exists (
    select 1
    from public.ai_outreach_contact_controls as control
    where control.account_id=v_run.account_id
      and control.contact_id=v_target.contact_id
      and control.channel=v_task.channel
      and control.state in ('opted_out','blocked')
      and (control.suppressed_until is null or control.suppressed_until>now())
  ) then
    return jsonb_build_object('reserved',false,'reason','suppressed');
  end if;

  if p_stop_on_reply and v_target.replied_at is not null then
    return jsonb_build_object('reserved',false,'reason','reply_stop');
  end if;

  v_followup_number:=greatest(v_target.attempt_count-1,0);
  if v_followup_number>p_max_followups then
    return jsonb_build_object('reserved',false,'reason','followup_limit');
  end if;

  select max(sent_at) into v_last_sent_at
  from public.ai_agent_task_outbound_messages
  where account_id=v_run.account_id
    and task_id=v_run.task_id
    and task_target_id=v_run.task_target_id
    and status='sent';

  if v_last_sent_at is not null then
    if now()<v_last_sent_at+make_interval(mins=>p_minimum_interval_minutes) then
      return jsonb_build_object('reserved',false,'reason','followup_too_early');
    end if;
    if p_maximum_interval_minutes>0
       and now()>v_last_sent_at+make_interval(mins=>p_maximum_interval_minutes) then
      return jsonb_build_object('reserved',false,'reason','followup_window_expired');
    end if;
  end if;

  select max(message.created_at) into v_last_inbound_at
  from public.messages as message
  where message.conversation_id=v_target.conversation_id
    and message.sender_type='customer';

  v_session_active:=(
    v_last_inbound_at is not null
    and v_last_inbound_at>=now()-interval '24 hours'
  );

  if p_message_kind='text' then
    if length(btrim(coalesce(p_candidate_text,'')))=0 then
      raise exception 'AGENT_OUTBOUND_TEXT_REQUIRED';
    end if;
    if not v_session_active then
      return jsonb_build_object('reserved',false,'reason','template_required');
    end if;
  else
    if length(btrim(coalesce(p_template_name,'')))=0
       or length(btrim(coalesce(p_template_language,'')))=0 then
      raise exception 'AGENT_OUTBOUND_TEMPLATE_REQUIRED';
    end if;

    if not exists (
      select 1
      from public.message_templates as template
      where template.account_id=v_run.account_id
        and template.name=p_template_name
        and lower(coalesce(template.language,''))=lower(p_template_language)
        and upper(coalesce(template.status,''))='APPROVED'
    ) then
      return jsonb_build_object('reserved',false,'reason','template_not_approved');
    end if;
  end if;

  v_idempotency_key:=
    'task:'||v_run.task_id::text||
    ':target:'||v_run.task_target_id::text||
    ':attempt:'||v_target.attempt_count::text;

  insert into public.ai_agent_task_outbound_messages (
    account_id,task_id,task_target_id,run_id,attempt_number,
    policy_key,policy_version,message_kind,candidate_text,
    template_name,template_language,template_params,
    session_window_active,session_last_inbound_at,status,idempotency_key
  ) values (
    v_run.account_id,v_run.task_id,v_run.task_target_id,v_run.id,
    v_target.attempt_count,p_policy_key,p_policy_version,p_message_kind,
    case when p_message_kind='text' then btrim(p_candidate_text) else p_candidate_text end,
    case when p_message_kind='template' then p_template_name else null end,
    case when p_message_kind='template' then p_template_language else null end,
    v_params,v_session_active,v_last_inbound_at,'reserved',v_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into v_reservation_id;

  if v_reservation_id is null then
    select id into v_reservation_id
    from public.ai_agent_task_outbound_messages
    where idempotency_key=v_idempotency_key;
  end if;

  perform public.append_agent_task_event(
    v_run.account_id,v_run.task_id,v_run.task_target_id,v_run.id,
    'message.reserved','service',p_policy_key,
    jsonb_build_object(
      'reservation_id',v_reservation_id,
      'message_kind',p_message_kind,
      'attempt',v_target.attempt_count,
      'session_window_active',v_session_active,
      'policy_version',p_policy_version
    )
  );

  return jsonb_build_object(
    'reserved',true,
    'reason','reserved',
    'reservation_id',v_reservation_id,
    'status','reserved',
    'message_kind',p_message_kind,
    'session_window_active',v_session_active,
    'idempotency_key',v_idempotency_key
  );
end;
$$;

revoke all on function public.reserve_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean
) from public,anon,authenticated;
grant execute on function public.reserve_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean
) to service_role;

create or replace function public.claim_agent_task_outbound_message(
  p_reservation_id uuid,
  p_worker_id text,
  p_lease_secs integer default 120
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_task_outbound_messages%rowtype;
  v_task_status text;
begin
  if length(btrim(coalesce(p_worker_id,'')))=0 then
    raise exception 'AGENT_OUTBOUND_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs<1 or p_lease_secs>3600 then
    raise exception 'AGENT_OUTBOUND_LEASE_INVALID';
  end if;

  select * into v_row
  from public.ai_agent_task_outbound_messages
  where id=p_reservation_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('claimed',false,'reason','not_found');
  end if;

  if v_row.status='sent' then
    return jsonb_build_object(
      'claimed',false,'reason','already_sent',
      'local_message_id',v_row.local_message_id,
      'whatsapp_message_id',v_row.whatsapp_message_id
    );
  end if;

  if v_row.status in ('sending','requires_reconciliation') then
    return jsonb_build_object('claimed',false,'reason','reconciliation_required');
  end if;

  if v_row.status<>'reserved' then
    return jsonb_build_object('claimed',false,'reason',v_row.status);
  end if;

  select status into v_task_status
  from public.ai_agent_tasks
  where id=v_row.task_id
    and account_id=v_row.account_id;

  if v_task_status='cancelled' then
    update public.ai_agent_task_outbound_messages
    set status='cancelled',error_code='TASK_CANCELLED'
    where id=v_row.id;

    return jsonb_build_object('claimed',false,'reason','task_cancelled');
  end if;

  if v_task_status<>'running' then
    return jsonb_build_object('claimed',false,'reason','task_not_running');
  end if;

  update public.ai_agent_task_outbound_messages
  set status='sending',
      claimed_by=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_secs)
  where id=v_row.id;

  return jsonb_build_object(
    'claimed',true,
    'reason','claimed',
    'reservation_id',v_row.id
  );
end;
$$;

revoke all on function public.claim_agent_task_outbound_message(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_agent_task_outbound_message(uuid,text,integer)
  to service_role;

create or replace function public.complete_agent_task_outbound_message(
  p_reservation_id uuid,
  p_worker_id text,
  p_local_message_id uuid,
  p_whatsapp_message_id text,
  p_input_tokens integer,
  p_output_tokens integer
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_task_outbound_messages%rowtype;
begin
  select * into v_row
  from public.ai_agent_task_outbound_messages
  where id=p_reservation_id
    and status='sending'
    and claimed_by=p_worker_id
  for update;

  if v_row.id is null then
    return false;
  end if;

  update public.ai_agent_task_outbound_messages
  set status='sent',
      local_message_id=p_local_message_id,
      whatsapp_message_id=nullif(btrim(coalesce(p_whatsapp_message_id,'')),''),
      sent_at=now(),
      claimed_by=null,
      lease_expires_at=null,
      error_code=null,
      error_detail=null
  where id=v_row.id;

  update public.ai_agent_runs
  set status='succeeded',
      completed_at=now(),
      outbound_message_id=p_local_message_id,
      input_tokens=greatest(coalesce(p_input_tokens,0),0),
      output_tokens=greatest(coalesce(p_output_tokens,0),0),
      error_code=null
  where id=v_row.run_id
    and account_id=v_row.account_id
    and task_id=v_row.task_id
    and status='claimed';

  update public.ai_agent_task_targets
  set status='awaiting_reply',
      first_contacted_at=coalesce(first_contacted_at,now()),
      last_outbound_message_id=p_local_message_id,
      failure_code=null,
      next_action_at=null,
      available_at=now()
  where id=v_row.task_target_id
    and account_id=v_row.account_id
    and task_id=v_row.task_id;

  perform public.append_agent_task_event(
    v_row.account_id,v_row.task_id,v_row.task_target_id,v_row.run_id,
    'message.sent','service',p_worker_id,
    jsonb_build_object(
      'reservation_id',v_row.id,
      'message_kind',v_row.message_kind,
      'local_message_id',p_local_message_id,
      'whatsapp_message_id',coalesce(p_whatsapp_message_id,''),
      'attempt',v_row.attempt_number
    )
  );

  return true;
end;
$$;

revoke all on function public.complete_agent_task_outbound_message(
  uuid,text,uuid,text,integer,integer
) from public,anon,authenticated;
grant execute on function public.complete_agent_task_outbound_message(
  uuid,text,uuid,text,integer,integer
) to service_role;

create or replace function public.mark_agent_task_outbound_reconciliation(
  p_reservation_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_detail text
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_task_outbound_messages%rowtype;
begin
  select * into v_row
  from public.ai_agent_task_outbound_messages
  where id=p_reservation_id
    and status='sending'
    and claimed_by=p_worker_id
  for update;

  if v_row.id is null then
    return false;
  end if;

  update public.ai_agent_task_outbound_messages
  set status='requires_reconciliation',
      claimed_by=null,
      lease_expires_at=null,
      error_code=nullif(btrim(coalesce(p_error_code,'')),''),
      error_detail=left(coalesce(p_error_detail,''),2000)
  where id=v_row.id;

  update public.ai_agent_runs
  set status='failed',
      completed_at=now(),
      error_code='OUTBOUND_REQUIRES_RECONCILIATION'
  where id=v_row.run_id
    and status in ('claimed','running','queued');

  update public.ai_agent_task_targets
  set failure_code='OUTBOUND_REQUIRES_RECONCILIATION'
  where id=v_row.task_target_id
    and account_id=v_row.account_id
    and task_id=v_row.task_id;

  perform public.append_agent_task_event(
    v_row.account_id,v_row.task_id,v_row.task_target_id,v_row.run_id,
    'message.requires_reconciliation','service',p_worker_id,
    jsonb_build_object(
      'reservation_id',v_row.id,
      'error_code',coalesce(p_error_code,'')
    )
  );

  return true;
end;
$$;

revoke all on function public.mark_agent_task_outbound_reconciliation(
  uuid,text,text,text
) from public,anon,authenticated;
grant execute on function public.mark_agent_task_outbound_reconciliation(
  uuid,text,text,text
) to service_role;

create or replace function public.fail_agent_task_outbound_run(
  p_run_id uuid,
  p_error_code text,
  p_delay_secs integer default 60
) returns text
language plpgsql
security definer
set search_path=public
as $$
declare
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_next_status text;
begin
  if p_delay_secs<0 or p_delay_secs>86400 then
    raise exception 'AGENT_OUTBOUND_RETRY_DELAY_INVALID';
  end if;

  select * into v_run
  from public.ai_agent_runs
  where id=p_run_id
    and run_mode='outbound'
  for update;

  if v_run.id is null or v_run.task_id is null or v_run.task_target_id is null then
    return null;
  end if;

  if exists (
    select 1
    from public.ai_agent_task_outbound_messages
    where run_id=v_run.id
      and status in ('sending','sent','requires_reconciliation')
  ) then
    return 'reconciliation_required';
  end if;

  select * into v_task
  from public.ai_agent_tasks
  where id=v_run.task_id
    and account_id=v_run.account_id
  for update;

  select * into v_target
  from public.ai_agent_task_targets
  where id=v_run.task_target_id
    and account_id=v_run.account_id
    and task_id=v_run.task_id
  for update;

  update public.ai_agent_runs
  set status='failed',
      completed_at=now(),
      error_code=left(coalesce(p_error_code,'OUTBOUND_FAILED'),120)
  where id=v_run.id
    and status in ('queued','claimed','running');

  if v_task.status in ('paused','cancelled') then
    return v_task.status;
  end if;

  if v_target.attempt_count>=v_task.max_attempts_per_target then
    v_next_status:='exhausted';
    update public.ai_agent_task_targets
    set status='exhausted',
        completed_at=coalesce(completed_at,now()),
        failure_code=left(coalesce(p_error_code,'OUTBOUND_FAILED'),120),
        next_action_at=null,
        available_at=now()
    where id=v_target.id;
  else
    v_next_status:='queued';
    update public.ai_agent_task_targets
    set status='queued',
        failure_code=left(coalesce(p_error_code,'OUTBOUND_FAILED'),120),
        next_action_at=now()+make_interval(secs=>p_delay_secs),
        available_at=now()+make_interval(secs=>p_delay_secs)
    where id=v_target.id;
  end if;

  perform public.append_agent_task_event(
    v_run.account_id,v_run.task_id,v_run.task_target_id,v_run.id,
    case when v_next_status='exhausted'
      then 'target.exhausted'
      else 'target.retry_scheduled'
    end,
    'service','outbound-policy',
    jsonb_build_object(
      'error_code',coalesce(p_error_code,'OUTBOUND_FAILED'),
      'delay_secs',case when v_next_status='queued' then p_delay_secs else 0 end
    )
  );

  return v_next_status;
end;
$$;

revoke all on function public.fail_agent_task_outbound_run(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.fail_agent_task_outbound_run(uuid,text,integer)
  to service_role;

create or replace function public.sweep_agent_task_outbound_messages(
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r record;
  v_reconciliation integer:=0;
  v_cancelled integer:=0;
begin
  for r in
    select outbound.*
    from public.ai_agent_task_outbound_messages as outbound
    where outbound.status='sending'
      and outbound.lease_expires_at is not null
      and outbound.lease_expires_at<p_now
    order by outbound.lease_expires_at asc
    for update skip locked
  loop
    update public.ai_agent_task_outbound_messages
    set status='requires_reconciliation',
        claimed_by=null,
        lease_expires_at=null,
        error_code=coalesce(error_code,'TRANSPORT_LEASE_EXPIRED'),
        error_detail=coalesce(
          error_detail,
          'Transport lease expired after send ownership was acquired; automatic resend is disabled.'
        )
    where id=r.id;

    update public.ai_agent_runs
    set status='failed',
        completed_at=coalesce(completed_at,p_now),
        error_code='OUTBOUND_REQUIRES_RECONCILIATION'
    where id=r.run_id
      and status in ('queued','claimed','running');

    update public.ai_agent_task_targets
    set failure_code='OUTBOUND_REQUIRES_RECONCILIATION'
    where id=r.task_target_id
      and account_id=r.account_id
      and task_id=r.task_id;

    perform public.append_agent_task_event(
      r.account_id,r.task_id,r.task_target_id,r.run_id,
      'message.requires_reconciliation','system','outbound-sweep',
      jsonb_build_object(
        'reservation_id',r.id,
        'reason','transport_lease_expired'
      )
    );

    v_reconciliation:=v_reconciliation+1;
  end loop;

  for r in
    select outbound.*
    from public.ai_agent_task_outbound_messages as outbound
    join public.ai_agent_tasks as task
      on task.account_id=outbound.account_id
     and task.id=outbound.task_id
    where outbound.status='reserved'
      and task.status='cancelled'
    for update of outbound skip locked
  loop
    update public.ai_agent_task_outbound_messages
    set status='cancelled',
        error_code='TASK_CANCELLED'
    where id=r.id;

    v_cancelled:=v_cancelled+1;
  end loop;

  return jsonb_build_object(
    'requires_reconciliation',v_reconciliation,
    'cancelled',v_cancelled
  );
end;
$$;

revoke all on function public.sweep_agent_task_outbound_messages(timestamptz)
  from public,anon,authenticated;
grant execute on function public.sweep_agent_task_outbound_messages(timestamptz)
  to service_role;
