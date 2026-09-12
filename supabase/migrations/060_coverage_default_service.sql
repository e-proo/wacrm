-- ============================================================
-- 060_coverage_default_service.sql — auto-provision the coverage
-- service per account.
--
-- The coverage marketplace rows (coverage_offers /
-- coverage_requests) require a service_id: the atomic booking RPC
-- gates on offer.service_id = request.service_id. Requiring the
-- operator to author a catalog service just to log a coverage
-- record was wrong — the desk works in offers and requests, not
-- in catalog management.
--
-- So every account gets a dedicated, always-present "coverage"
-- service (category 'coverage' → service code 'coverage'). The
-- coverage panel binds to it implicitly; offer ↔ request matches
-- always share it.
--
-- Same pattern as the currency/region seeds (052 / 059): seed
-- function + account-create trigger + backfill for existing
-- accounts. Idempotent — safe to re-run.
-- ============================================================

create or replace function public.seed_default_coverage_service_for_account(
  p_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category_id uuid;
begin
  -- 1) The 'coverage' category (047: unique on (account_id, slug)).
  insert into public.service_categories (account_id, slug, name, status)
  values (p_account_id, 'coverage', 'التغطية', 'active')
  on conflict (account_id, slug) do nothing;

  select id into v_category_id
    from public.service_categories
   where account_id = p_account_id
     and slug = 'coverage';

  -- 2) The 'coverage' service (048: unique on (account_id, code)).
  insert into public.services
    (account_id, category_id, code, slug, name, status)
  values
    (p_account_id, v_category_id, 'coverage', 'coverage', 'التغطية', 'active')
  on conflict (account_id, code) do nothing;

  -- If the service already existed under a different category
  -- (admin-authored), leave it alone — matching only needs ONE
  -- service code shared by every coverage row, and the panel
  -- resolves by code.
end;
$$;

revoke all on function public.seed_default_coverage_service_for_account(uuid) from public;
grant execute on function public.seed_default_coverage_service_for_account(uuid) to service_role;

create or replace function public.trg_seed_default_coverage_service_on_account()
returns trigger as $$
begin
  perform public.seed_default_coverage_service_for_account(new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists accounts_seed_coverage_service on public.accounts;
create trigger accounts_seed_coverage_service
  after insert on public.accounts
  for each row execute function public.trg_seed_default_coverage_service_on_account();

do $$
declare
  v_account record;
begin
  for v_account in select id from public.accounts loop
    perform public.seed_default_coverage_service_for_account(v_account.id);
  end loop;
end$$;
