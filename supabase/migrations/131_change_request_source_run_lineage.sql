-- ============================================================
-- 131_change_request_source_run_lineage.sql
-- Phase 15: preserve the originating Agent Run for model-created proposals.
-- This creates an explicit lineage:
-- Task -> Target -> Run -> Change Request -> Business Event.
-- ============================================================

alter table public.change_requests
  add column if not exists source_run_id uuid
    references public.ai_agent_runs(id) on delete set null;

create index if not exists change_requests_source_run_idx
  on public.change_requests(account_id, source_run_id)
  where source_run_id is not null;

create or replace function public.enforce_change_request_source_run_tenant()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
begin
  if new.source_run_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.ai_agent_runs as run
    where run.id=new.source_run_id
      and run.account_id=new.account_id
  ) then
    raise exception 'CHANGE_REQUEST_SOURCE_RUN_TENANT_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_change_request_source_run_tenant()
  from public,anon,authenticated;

drop trigger if exists change_requests_source_run_tenant_guard
  on public.change_requests;
create trigger change_requests_source_run_tenant_guard
  before insert or update of account_id,source_run_id
  on public.change_requests
  for each row
  execute function public.enforce_change_request_source_run_tenant();
