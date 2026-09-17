-- ============================================================
-- 087_fx_trade_change_request_target_type.sql
-- Allow FX V2 trade requests to use the change-request review loop.
-- ============================================================

alter table public.change_requests
drop constraint if exists change_requests_target_type_check;

alter table public.change_requests
add constraint change_requests_target_type_check
check (
  target_type in (
    'service',
    'service_revision',
    'pricing_rule',
    'rate_book_version',
    'coverage_offer',
    'coverage_request',
    'fx_trade_request'
  )
);