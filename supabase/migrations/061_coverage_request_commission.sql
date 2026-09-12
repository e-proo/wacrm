-- ============================================================
-- 061_coverage_request_commission.sql — commission on coverage
-- requests, mirroring the offer columns from 059.
--
-- The desk asked for the requester to optionally state a target
-- commission too. The columns stay OPTIONAL: a request without a
-- commission simply reviews offers with THEIR commission in the
-- suggestions view.
--
-- Same generated-column equation: amount × rate ÷ 1000.
-- Idempotent — safe to re-run.
-- ============================================================

alter table public.coverage_requests
  add column if not exists commission_per_thousand numeric(12, 4);

alter table public.coverage_requests
  add column if not exists commission_currency text;

do $$
begin
  begin
    alter table public.coverage_requests
      add constraint coverage_requests_commission_rate_check
      check (commission_per_thousand is null or commission_per_thousand >= 0);
  exception when duplicate_object then
    null;
  end;
end$$;

do $$
begin
  begin
    alter table public.coverage_requests
      add constraint coverage_requests_commission_currency_check
      check (commission_currency is null or commission_currency ~ '^[A-Z_]{3,8}$');
  exception when duplicate_object then
    null;
  end;
end$$;

alter table public.coverage_requests
  add column if not exists commission_amount numeric(20, 4)
  generated always as (
    case
      when commission_per_thousand is null then null
      else requested_amount * commission_per_thousand / 1000.0
    end
  ) stored;
