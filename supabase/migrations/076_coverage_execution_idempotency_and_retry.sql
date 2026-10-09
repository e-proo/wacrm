-- ============================================================
-- 076_coverage_execution_idempotency_and_retry.sql
-- Make coverage execution idempotency compatible with PostgREST/Supabase
-- ON CONFLICT(source_change_request_id), and keep transient/unclassified
-- execution failures retryable after human approval.
-- ============================================================

-- PostgreSQL UNIQUE indexes already allow multiple NULL values, so the
-- previous partial predicate is unnecessary. More importantly, a partial
-- unique index cannot be inferred by ON CONFLICT(source_change_request_id)
-- unless the conflict target repeats its predicate; PostgREST onConflict
-- supplies only the column list.
drop index if exists public.coverage_offers_source_change_request_uidx;
create unique index coverage_offers_source_change_request_uidx
  on public.coverage_offers (source_change_request_id);

drop index if exists public.coverage_requests_source_change_request_uidx;
create unique index coverage_requests_source_change_request_uidx
  on public.coverage_requests (source_change_request_id);

-- Generic/unclassified executor failures are normally infrastructure/runtime
-- failures. Preserve the existing human approval so the same deterministic
-- admin command can retry after the fault is repaired. Specific deterministic
-- business/safety errors retain the terminal failed state.
create or replace function public.fail_change_request_execution(
  p_account_id uuid,
  p_change_request_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_error_code text := left(coalesce(p_error_code, 'EXECUTION_FAILED'), 120);
begin
  update public.change_requests as cr
     set status = case
           when v_error_code = 'EXECUTION_FAILED' then 'approved'
           else 'failed'
         end,
         error_code = v_error_code,
         execution_claim_token = null,
         executing_started_at = case
           when v_error_code = 'EXECUTION_FAILED' then null
           else cr.executing_started_at
         end
   where cr.id = p_change_request_id
     and cr.account_id = p_account_id
     and cr.status = 'executing'
     and cr.execution_claim_token = p_claim_token;

  return found;
end;
$$;

revoke execute on function public.fail_change_request_execution(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_change_request_execution(uuid, uuid, uuid, text)
  to service_role;
