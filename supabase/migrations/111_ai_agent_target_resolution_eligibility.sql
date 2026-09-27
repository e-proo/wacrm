-- ============================================================
-- 111_ai_agent_target_resolution_eligibility.sql
-- Deterministic target materialization + outreach suppression.
-- ============================================================

alter table public.ai_agent_task_targets
  add column if not exists resolver_key text,
  add column if not exists resolver_version integer,
  add column if not exists eligibility_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_agent_task_targets'::regclass
      and conname='ai_agent_task_targets_resolver_version_check'
  ) then
    alter table public.ai_agent_task_targets
      add constraint ai_agent_task_targets_resolver_version_check
      check (resolver_version is null or resolver_version > 0) not valid;
  end if;
end
$$;

alter table public.ai_agent_task_targets
  validate constraint ai_agent_task_targets_resolver_version_check;

create table if not exists public.ai_outreach_contact_controls (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  contact_id uuid not null,
  channel text not null check (channel in ('whatsapp')),
  state text not null check (state in ('opted_out','blocked')),
  reason text,
  source text not null default 'admin',
  suppressed_until timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_outreach_contact_controls_account_contact_fk
    foreign key (account_id, contact_id)
    references public.contacts(account_id, id)
    on delete cascade,
  constraint ai_outreach_contact_controls_account_contact_channel_uidx
    unique (account_id, contact_id, channel)
);

create index if not exists ai_outreach_contact_controls_active_idx
  on public.ai_outreach_contact_controls (
    account_id, channel, state, suppressed_until, contact_id
  );

alter table public.ai_outreach_contact_controls enable row level security;

drop policy if exists ai_outreach_contact_controls_select
  on public.ai_outreach_contact_controls;
create policy ai_outreach_contact_controls_select
  on public.ai_outreach_contact_controls
  for select
  using (is_account_member(account_id));

drop policy if exists ai_outreach_contact_controls_insert
  on public.ai_outreach_contact_controls;
create policy ai_outreach_contact_controls_insert
  on public.ai_outreach_contact_controls
  for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_outreach_contact_controls_update
  on public.ai_outreach_contact_controls;
create policy ai_outreach_contact_controls_update
  on public.ai_outreach_contact_controls
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_outreach_contact_controls_delete
  on public.ai_outreach_contact_controls;
create policy ai_outreach_contact_controls_delete
  on public.ai_outreach_contact_controls
  for delete
  using (is_account_member(account_id, 'admin'));

revoke all on table public.ai_outreach_contact_controls
  from anon, authenticated;
grant select, insert, update, delete
  on table public.ai_outreach_contact_controls
  to authenticated;
grant all on table public.ai_outreach_contact_controls
  to service_role;

create or replace function public.update_ai_outreach_contact_controls_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

drop trigger if exists ai_outreach_contact_controls_updated_at
  on public.ai_outreach_contact_controls;
create trigger ai_outreach_contact_controls_updated_at
  before update on public.ai_outreach_contact_controls
  for each row
  execute function public.update_ai_outreach_contact_controls_updated_at();

create or replace function public.materialize_agent_task_contact_target(
  p_task_id uuid,
  p_contact_id uuid,
  p_counterparty_role text,
  p_resolver_key text,
  p_resolver_version integer,
  p_required_tag_ids uuid[],
  p_excluded_tag_ids uuid[],
  p_max_new_contacts_per_hour integer,
  p_max_contacts_per_agent_per_day integer,
  p_cooldown_minutes integer,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_contact public.contacts%rowtype;
  v_existing_target public.ai_agent_task_targets%rowtype;
  v_conversation_id uuid;
  v_target_id uuid;
  v_target_count integer;
  v_hour_count integer;
  v_day_count integer;
  v_required uuid[]:=coalesce(p_required_tag_ids,'{}'::uuid[]);
  v_excluded uuid[]:=coalesce(p_excluded_tag_ids,'{}'::uuid[]);
  v_snapshot jsonb;
begin
  if length(btrim(coalesce(p_counterparty_role,'')))=0 then
    raise exception 'AGENT_TASK_COUNTERPARTY_ROLE_REQUIRED';
  end if;
  if length(btrim(coalesce(p_resolver_key,'')))=0 then
    raise exception 'AGENT_TASK_RESOLVER_KEY_REQUIRED';
  end if;
  if p_resolver_version is null or p_resolver_version<1 then
    raise exception 'AGENT_TASK_RESOLVER_VERSION_INVALID';
  end if;
  if p_max_new_contacts_per_hour is null
     or p_max_new_contacts_per_hour<1
     or p_max_new_contacts_per_hour>10000 then
    raise exception 'AGENT_TASK_HOURLY_CONTACT_LIMIT_INVALID';
  end if;
  if p_max_contacts_per_agent_per_day is null
     or p_max_contacts_per_agent_per_day<1
     or p_max_contacts_per_agent_per_day>100000 then
    raise exception 'AGENT_TASK_DAILY_AGENT_CONTACT_LIMIT_INVALID';
  end if;
  if p_cooldown_minutes is null
     or p_cooldown_minutes<0
     or p_cooldown_minutes>525600 then
    raise exception 'AGENT_TASK_CONTACT_COOLDOWN_INVALID';
  end if;
  if length(btrim(coalesce(p_idempotency_key,'')))=0 then
    raise exception 'AGENT_TASK_TARGET_IDEMPOTENCY_REQUIRED';
  end if;
  if cardinality(v_required)>100 or cardinality(v_excluded)>100 then
    raise exception 'AGENT_TASK_TAG_FILTER_TOO_LARGE';
  end if;

  select * into v_task
  from public.ai_agent_tasks
  where id=p_task_id
  for update;

  if v_task.id is null then
    return jsonb_build_object('accepted',false,'reason','task_not_found');
  end if;

  if v_task.status not in ('validating','scheduled','queued','running') then
    return jsonb_build_object('accepted',false,'reason','task_not_active');
  end if;

  select * into v_contact
  from public.contacts
  where id=p_contact_id
    and account_id=v_task.account_id
  for update;

  if v_contact.id is null then
    return jsonb_build_object('accepted',false,'reason','contact_not_found');
  end if;

  if v_task.channel='whatsapp'
     and (
       v_contact.phone_normalized is null
       or v_contact.phone_normalized !~ '^[0-9]{8,15}$'
     ) then
    return jsonb_build_object('accepted',false,'reason','channel_unavailable');
  end if;

  select * into v_existing_target
  from public.ai_agent_task_targets
  where account_id=v_task.account_id
    and task_id=v_task.id
    and contact_id=v_contact.id
  limit 1;

  if v_existing_target.id is not null then
    return jsonb_build_object(
      'accepted',false,
      'reason','duplicate',
      'target_id',v_existing_target.id,
      'status',v_existing_target.status
    );
  end if;

  if exists (
    select 1
    from public.ai_outreach_contact_controls as control
    where control.account_id=v_task.account_id
      and control.contact_id=v_contact.id
      and control.channel=v_task.channel
      and control.state in ('opted_out','blocked')
      and (
        control.suppressed_until is null
        or control.suppressed_until>now()
      )
  ) then
    return jsonb_build_object('accepted',false,'reason','suppressed');
  end if;

  if exists (
    select 1
    from unnest(v_required) as required_tag(id)
    where not exists (
      select 1
      from public.contact_tags as ct
      join public.tags as tag
        on tag.id=ct.tag_id
       and tag.account_id=v_task.account_id
      where ct.contact_id=v_contact.id
        and ct.tag_id=required_tag.id
    )
  ) then
    return jsonb_build_object(
      'accepted',false,'reason','required_segment_missing'
    );
  end if;

  if exists (
    select 1
    from public.contact_tags as ct
    join public.tags as tag
      on tag.id=ct.tag_id
     and tag.account_id=v_task.account_id
    where ct.contact_id=v_contact.id
      and ct.tag_id=any(v_excluded)
  ) then
    return jsonb_build_object(
      'accepted',false,'reason','excluded_segment'
    );
  end if;

  select count(*) into v_target_count
  from public.ai_agent_task_targets
  where account_id=v_task.account_id
    and task_id=v_task.id;

  if v_target_count>=v_task.max_targets then
    return jsonb_build_object('accepted',false,'reason','task_target_limit');
  end if;

  select count(*) into v_hour_count
  from public.ai_agent_task_targets
  where account_id=v_task.account_id
    and contact_id is not null
    and created_at>=now()-interval '1 hour';

  if v_hour_count>=p_max_new_contacts_per_hour then
    return jsonb_build_object(
      'accepted',false,'reason','account_hourly_contact_limit'
    );
  end if;

  select count(distinct target.contact_id) into v_day_count
  from public.ai_agent_task_targets as target
  join public.ai_agent_tasks as task
    on task.account_id=target.account_id
   and task.id=target.task_id
  where target.account_id=v_task.account_id
    and task.agent_id=v_task.agent_id
    and target.contact_id is not null
    and target.created_at>=date_trunc('day',now());

  if v_day_count>=p_max_contacts_per_agent_per_day then
    return jsonb_build_object(
      'accepted',false,'reason','agent_daily_contact_limit'
    );
  end if;

  if p_cooldown_minutes>0 and exists (
    select 1
    from public.ai_agent_task_targets as prior
    join public.ai_agent_tasks as prior_task
      on prior_task.account_id=prior.account_id
     and prior_task.id=prior.task_id
    where prior.account_id=v_task.account_id
      and prior.contact_id=v_contact.id
      and prior.task_id<>v_task.id
      and prior_task.channel=v_task.channel
      and greatest(
        coalesce(prior.first_contacted_at,prior.created_at),
        coalesce(prior.last_attempt_at,prior.created_at),
        prior.created_at
      )>now()-make_interval(mins=>p_cooldown_minutes)
  ) then
    return jsonb_build_object('accepted',false,'reason','contact_cooldown');
  end if;

  select conversation.id into v_conversation_id
  from public.conversations as conversation
  where conversation.account_id=v_task.account_id
    and conversation.contact_id=v_contact.id
  order by
    conversation.updated_at desc nulls last,
    conversation.created_at desc nulls last,
    conversation.id desc
  limit 1;

  if v_conversation_id is null then
    insert into public.conversations (
      user_id,account_id,contact_id,status
    ) values (
      v_contact.user_id,v_task.account_id,v_contact.id,'open'
    )
    returning id into v_conversation_id;
  end if;

  v_snapshot:=jsonb_build_object(
    'required_tag_ids',to_jsonb(v_required),
    'excluded_tag_ids',to_jsonb(v_excluded),
    'max_new_contacts_per_hour',p_max_new_contacts_per_hour,
    'max_contacts_per_agent_per_day',p_max_contacts_per_agent_per_day,
    'cooldown_minutes',p_cooldown_minutes,
    'channel',v_task.channel,
    'evaluated_at',now()
  );

  insert into public.ai_agent_task_targets (
    account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,idempotency_key,resolver_key,resolver_version,
    eligibility_snapshot,available_at
  ) values (
    v_task.account_id,v_task.id,v_contact.id,p_counterparty_role,'eligible',
    v_conversation_id,p_idempotency_key,p_resolver_key,p_resolver_version,
    v_snapshot,now()
  )
  returning id into v_target_id;

  perform public.append_agent_task_event(
    v_task.account_id,v_task.id,v_target_id,null,
    'target.selected','service',p_resolver_key,
    jsonb_build_object(
      'contact_id',v_contact.id,
      'counterparty_role',p_counterparty_role,
      'resolver_key',p_resolver_key,
      'resolver_version',p_resolver_version,
      'eligibility',v_snapshot
    )
  );

  return jsonb_build_object(
    'accepted',true,
    'reason','eligible',
    'target_id',v_target_id,
    'conversation_id',v_conversation_id
  );
end;
$$;

revoke all on function public.materialize_agent_task_contact_target(
  uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text
) from public,anon,authenticated;
grant execute on function public.materialize_agent_task_contact_target(
  uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text
) to service_role;
