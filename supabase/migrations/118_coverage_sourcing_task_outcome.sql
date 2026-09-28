-- ============================================================
-- 118_coverage_sourcing_task_outcome.sql
-- Phase 11: reconcile an approved supplier Coverage Offer back into
-- the correlated coverage.sourcing Agent Task.
--
-- Domain-owned trigger; no Coverage branch is added to the generic Task Kernel.
-- ============================================================

create or replace function public.reconcile_coverage_sourcing_offer_task()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_source_message_id uuid;
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_request_id uuid;
  v_request public.coverage_requests%rowtype;
  v_remaining numeric;
  v_available_supply numeric := 0;
  v_target_updated integer := 0;
begin
  if tg_op <> 'INSERT'
     or new.status <> 'active'
     or new.source_change_request_id is null then
    return new;
  end if;

  select
    case
      when coalesce(cr.proposed_payload ->> 'source_message_id', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (cr.proposed_payload ->> 'source_message_id')::uuid
      else null
    end
  into v_source_message_id
  from public.change_requests as cr
  where cr.account_id = new.account_id
    and cr.id = new.source_change_request_id;

  if v_source_message_id is null then
    return new;
  end if;

  select run.*
    into v_run
  from public.ai_agent_runs as run
  where run.account_id = new.account_id
    and run.inbound_message_id = v_source_message_id
    and run.trigger_type = 'task_reply'
    and run.task_id is not null
    and run.task_target_id is not null
  order by run.created_at desc
  limit 1;

  if v_run.id is null then
    return new;
  end if;

  select task.*
    into v_task
  from public.ai_agent_tasks as task
  where task.account_id = new.account_id
    and task.id = v_run.task_id
    and task.task_type = 'coverage.sourcing'
    and task.task_type_version = 1
    and task.status in ('running', 'paused')
  for update;

  if v_task.id is null then
    return new;
  end if;

  if coalesce(v_task.task_context ->> 'coverageRequestId', '')
     !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'COVERAGE_SOURCING_REQUEST_ID_REQUIRED';
  end if;

  v_request_id := (v_task.task_context ->> 'coverageRequestId')::uuid;

  select target.*
    into v_target
  from public.ai_agent_task_targets as target
  where target.account_id = new.account_id
    and target.task_id = v_task.id
    and target.id = v_run.task_target_id
  for update;

  if v_target.id is null
     or v_target.contact_id is distinct from new.provider_contact_id then
    raise exception 'COVERAGE_SOURCING_TARGET_OFFER_MISMATCH';
  end if;

  update public.ai_agent_task_targets
     set status = 'completed',
         completed_at = coalesce(completed_at, pg_catalog.now()),
         next_action_at = null,
         available_at = pg_catalog.now(),
         lease_expires_at = null,
         claimed_by = null,
         failure_code = null
   where id = v_target.id
     and account_id = new.account_id
     and task_id = v_task.id
     and status not in ('completed', 'skipped', 'failed', 'opted_out', 'exhausted');

  get diagnostics v_target_updated = row_count;

  if v_target_updated > 0 then
    perform public.append_agent_task_event(
      new.account_id,
      v_task.id,
      v_target.id,
      v_run.id,
      'target.completed',
      'service',
      'coverage.sourcing',
      pg_catalog.jsonb_build_object(
        'outcome', 'valid_offer_recorded',
        'coverage_offer_id', new.id,
        'coverage_request_id', v_request_id,
        'change_request_id', new.source_change_request_id
      )
    );
  end if;

  select request.*
    into v_request
  from public.coverage_requests as request
  where request.account_id = new.account_id
    and request.id = v_request_id;

  if v_request.id is null then
    raise exception 'COVERAGE_SOURCING_REQUEST_NOT_FOUND';
  end if;

  v_remaining := pg_catalog.greatest(
    v_request.requested_amount
      - v_request.reserved_amount
      - v_request.fulfilled_amount,
    0
  );

  select coalesce(
    sum(
      pg_catalog.greatest(
        offer.total_amount - offer.reserved_amount - offer.fulfilled_amount,
        0
      )
    ),
    0
  )
  into v_available_supply
  from public.coverage_offers as offer
  where offer.account_id = new.account_id
    and offer.service_id = v_request.service_id
    and offer.currency = v_request.currency
    and offer.provider_contact_id <> v_request.requester_contact_id
    and offer.status in ('active', 'partially_reserved')
    and pg_catalog.greatest(
      offer.total_amount - offer.reserved_amount - offer.fulfilled_amount,
      0
    ) > 0
    and coalesce(offer.attributes ->> 'coverage_scope', 'domestic')
      = coalesce(v_request.attributes ->> 'coverage_scope', 'domestic')
    and (
      coalesce(v_request.attributes ->> 'coverage_scope', 'domestic') <> 'international'
      or nullif(v_request.attributes ->> 'coverage_country', '') is null
      or nullif(offer.attributes ->> 'coverage_country', '') is null
      or offer.attributes ->> 'coverage_country'
        = v_request.attributes ->> 'coverage_country'
    )
    and (
      nullif(v_request.attributes ->> 'receive_region_id', '') is null
      or nullif(offer.attributes ->> 'pay_region_id', '') is null
      or offer.attributes ->> 'pay_region_id'
        = v_request.attributes ->> 'receive_region_id'
    )
    and (
      nullif(v_request.attributes ->> 'pay_region_id', '') is null
      or nullif(offer.attributes ->> 'receive_region_id', '') is null
      or offer.attributes ->> 'receive_region_id'
        = v_request.attributes ->> 'pay_region_id'
    )
    and (
      coalesce(v_request.attributes ->> 'receive_method', 'any') = 'any'
      or coalesce(offer.attributes ->> 'pay_method', 'any') = 'any'
      or offer.attributes ->> 'pay_method'
        = v_request.attributes ->> 'receive_method'
    )
    and (
      coalesce(v_request.attributes ->> 'pay_method', 'any') = 'any'
      or coalesce(offer.attributes ->> 'receive_method', 'any') = 'any'
      or offer.attributes ->> 'receive_method'
        = v_request.attributes ->> 'pay_method'
    );

  if v_remaining > 0 and v_available_supply < v_remaining then
    return new;
  end if;

  update public.ai_agent_tasks
     set status = 'completed',
         completed_at = coalesce(completed_at, pg_catalog.now()),
         claimed_by = null,
         lease_expires_at = null,
         available_at = pg_catalog.now()
   where id = v_task.id
     and account_id = new.account_id
     and status in ('running', 'paused');

  update public.ai_agent_task_targets
     set status = 'skipped',
         skip_reason = 'task_business_outcome_satisfied',
         completed_at = coalesce(completed_at, pg_catalog.now()),
         next_action_at = null,
         available_at = pg_catalog.now(),
         claimed_by = null,
         lease_expires_at = null
   where account_id = new.account_id
     and task_id = v_task.id
     and id <> v_target.id
     and status in (
       'candidate',
       'eligible',
       'queued',
       'preparing',
       'contacted',
       'awaiting_reply',
       'replied',
       'in_progress',
       'paused_for_human'
     );

  update public.ai_agent_task_outbound_messages
     set status = 'cancelled',
         error_code = 'TASK_BUSINESS_OUTCOME_SATISFIED',
         claimed_by = null,
         lease_expires_at = null
   where account_id = new.account_id
     and task_id = v_task.id
     and status = 'reserved';

  update public.ai_agent_runs
     set status = 'failed',
         completed_at = coalesce(completed_at, pg_catalog.now()),
         error_code = 'TASK_BUSINESS_OUTCOME_SATISFIED'
   where account_id = new.account_id
     and task_id = v_task.id
     and run_mode = 'outbound'
     and status = 'queued';

  perform public.append_agent_task_event(
    new.account_id,
    v_task.id,
    null,
    null,
    'task.completed',
    'service',
    'coverage.sourcing',
    pg_catalog.jsonb_build_object(
      'outcome', 'required_amount_satisfied',
      'coverage_request_id', v_request_id,
      'available_supply', v_available_supply::text,
      'remaining_amount', v_remaining::text,
      'triggering_offer_id', new.id
    )
  );

  return new;
end;
$$;

revoke all on function public.reconcile_coverage_sourcing_offer_task()
  from public, anon, authenticated;

drop trigger if exists coverage_offers_agent_task_outcome
  on public.coverage_offers;

create trigger coverage_offers_agent_task_outcome
  after insert on public.coverage_offers
  for each row
  execute function public.reconcile_coverage_sourcing_offer_task();
