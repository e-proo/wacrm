-- ============================================================
-- 069_coverage_direction_semantics.sql
-- Canonical business semantics for domestic Yemen coverage.
--
-- This migration intentionally adds documentation, not a second pricing
-- system. The authoritative behavior is enforced in the application tools
-- and matcher; these DB comments keep operators and future migrations from
-- reintroducing the old ambiguous offer/request interpretation.
--
-- CUSTOMER LEGS are authoritative:
--   PAY SOUTH -> RECEIVE NORTH = coverage OFFER
--     commission effect: returned to customer (راجع للعميل)
--   PAY NORTH -> RECEIVE SOUTH = coverage REQUEST
--     commission effect: customer pays it (عمولة)
--
-- "راجع" and "عمولة" are NOT different commission products. Payment and
-- receipt methods (cash/networks/remittance/bank deposit) do not change the
-- offer/request classification.
-- ============================================================

comment on table public.coverage_offers is
  'Coverage offers. Canonical domestic direction uses CUSTOMER legs: pay SOUTH -> receive NORTH. The coverage commission is returned to the customer (راجع للعميل). Do not classify from wording or method.';

comment on table public.coverage_requests is
  'Coverage requests. Canonical domestic direction uses CUSTOMER legs: pay NORTH -> receive SOUTH. The customer pays the coverage commission (عمولة). Do not classify from wording or method.';

comment on column public.coverage_offers.attributes is
  'Customer coverage legs JSON: pay_region_id/pay_method = where/how customer pays; receive_region_id/receive_method = where/how customer receives. Domestic offer must resolve SOUTH -> NORTH.';

comment on column public.coverage_requests.attributes is
  'Customer coverage legs JSON: pay_region_id/pay_method = where/how customer pays; receive_region_id/receive_method = where/how customer receives. Domestic request must resolve NORTH -> SOUTH.';

comment on column public.coverage_commission_cards.north_coverage is
  'Coverage rate per 1000 used when the customer receives in NORTH after paying in SOUTH: canonical OFFER / راجع للعميل.';

comment on column public.coverage_commission_cards.south_coverage is
  'Coverage rate per 1000 used when the customer receives in SOUTH after paying in NORTH: canonical REQUEST / عمولة يدفعها العميل.';

-- SQL helper for admin/debugging/reporting. Application code independently
-- enforces the same rule; this function is not an authorization boundary.
create or replace function public.coverage_direction_from_macros(
  p_pay_macro text,
  p_receive_macro text
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when p_pay_macro = 'south' and p_receive_macro = 'north' then
      jsonb_build_object(
        'supported', true,
        'case_type', 'offer',
        'commission_effect', 'customer_receives',
        'customer_term_ar', 'راجع للعميل',
        'rate_market', 'north',
        'code', 'SOUTH_TO_NORTH_OFFER'
      )
    when p_pay_macro = 'north' and p_receive_macro = 'south' then
      jsonb_build_object(
        'supported', true,
        'case_type', 'request',
        'commission_effect', 'customer_pays',
        'customer_term_ar', 'عمولة',
        'rate_market', 'south',
        'code', 'NORTH_TO_SOUTH_REQUEST'
      )
    when p_pay_macro is null or p_receive_macro is null then
      jsonb_build_object(
        'supported', false,
        'case_type', null,
        'code', 'DIRECTION_INCOMPLETE'
      )
    when p_pay_macro = p_receive_macro then
      jsonb_build_object(
        'supported', false,
        'case_type', null,
        'code', 'SAME_MARKET_NOT_CROSS_COVERAGE'
      )
    else
      jsonb_build_object(
        'supported', false,
        'case_type', null,
        'code', 'INTERNATIONAL_DIRECTION_REQUIRES_POLICY'
      )
  end;
$$;

comment on function public.coverage_direction_from_macros(text, text) is
  'Deterministically classifies domestic coverage from CUSTOMER pay/receive macro regions. SOUTH->NORTH=offer/راجع للعميل; NORTH->SOUTH=request/عمولة.';
