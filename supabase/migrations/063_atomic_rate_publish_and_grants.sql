-- ============================================================
-- 063_atomic_rate_publish_and_grants.sql
--
-- Two SECURITY INVOKER helpers that make previously non-atomic
-- app sequences single-transaction:
--
-- 1) publish_coverage_rate_card — demote the account's current
--    commission card AND insert the new one atomically. The old
--    app path ran the demote and insert as two service-role calls;
--    an insert failure (overflow, concurrent publish hitting the
--    partial unique index, transient error) left the account with
--    NO current card — customers-facing quoting lost its source.
--
-- 2) replace_ai_agent_tool_grants — re-check that the revision is
--    still a DRAFT owned by the given agent/account INSIDE the
--    transaction (FOR UPDATE locks the row against a concurrent
--    publish) and only then delete + re-insert grants. The old
--    check-then-write left grants on a just-published revision
--    open to mutation.
--
-- Both are SECURITY INVOKER so the caller's RLS applies — the
-- routes call them with the user-scoped client, not the service
-- role. RLS on both tables already requires admin membership for
-- writes; the explicit membership guard below is defense-in-depth
-- for direct RPC use.
-- ============================================================

-- ------------------------------------------------------------
-- 1) publish_coverage_rate_card
-- ------------------------------------------------------------
create or replace function public.publish_coverage_rate_card(
  p_account_id uuid,
  p_card       jsonb,
  p_notes      text,
  p_created_by uuid
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_account_member(p_account_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- One statement = the old card stops being current…
  update public.coverage_commission_cards
     set is_current = false
   where account_id = p_account_id
     and is_current = true;

  -- …and exactly one statement later the new card is. If the
  -- insert fails (check constraint, numeric overflow, unique
  -- index race), the whole transaction aborts and the previous
  -- board stays current.
  insert into public.coverage_commission_cards (
    account_id,
    north_cash, north_remit, north_coverage,
    south_cash, south_remit, south_coverage,
    intl_cash,  intl_remit,  intl_coverage,
    notes, is_current, created_by
  ) values (
    p_account_id,
    (p_card->>'north_cash')::numeric,
    (p_card->>'north_remit')::numeric,
    (p_card->>'north_coverage')::numeric,
    (p_card->>'south_cash')::numeric,
    (p_card->>'south_remit')::numeric,
    (p_card->>'south_coverage')::numeric,
    (p_card->>'intl_cash')::numeric,
    (p_card->>'intl_remit')::numeric,
    (p_card->>'intl_coverage')::numeric,
    nullif(coalesce(p_notes, ''), ''),
    true,
    p_created_by
  )
  returning id into v_id;

  return v_id;
end $$;

comment on function public.publish_coverage_rate_card is 'Atomically swap the account current commission rate card (insert new + demote old in one transaction). Caller RLS + admin membership enforced.';

revoke execute on function public.publish_coverage_rate_card(uuid, jsonb, text, uuid) from public;
grant execute on function public.publish_coverage_rate_card(uuid, jsonb, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2) replace_ai_agent_tool_grants
-- ------------------------------------------------------------
create or replace function public.replace_ai_agent_tool_grants(
  p_account_id  uuid,
  p_agent_id    uuid,
  p_revision_id uuid,
  p_grants      jsonb,  -- array of {tool_key, tool_version, permission, constraints}
  p_granted_by  uuid
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  n integer := 0;
begin
  if not is_account_member(p_account_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the revision row: a concurrent publish either finished
  -- before us (caught here) or blocks until this transaction ends.
  select r.status into v_status
    from public.ai_agent_revisions r
   where r.id = p_revision_id
     and r.account_id = p_account_id
     and r.agent_id = p_agent_id
   for update;
  if v_status is null then
    raise exception 'revision not found' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'only draft revisions can change tool grants'
      using errcode = 'P0001';
  end if;

  delete from public.ai_agent_tool_grants
   where account_id = p_account_id
     and agent_revision_id = p_revision_id;

  insert into public.ai_agent_tool_grants (
    account_id, agent_revision_id, tool_key, tool_version, permission, constraints, granted_by
  )
  select
    p_account_id,
    p_revision_id,
    g->>'tool_key',
    coalesce((g->>'tool_version')::integer, 1),
    g->>'permission',
    coalesce(g->'constraints', '{}'::jsonb),
    p_granted_by
  from jsonb_array_elements(p_grants) as g;

  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.replace_ai_agent_tool_grants is 'Atomically verify draft state and replace every tool grant of a revision. Caller RLS + admin membership enforced.';

revoke execute on function public.replace_ai_agent_tool_grants(uuid, uuid, uuid, jsonb, uuid) from public;
grant execute on function public.replace_ai_agent_tool_grants(uuid, uuid, uuid, jsonb, uuid) to authenticated, service_role;
