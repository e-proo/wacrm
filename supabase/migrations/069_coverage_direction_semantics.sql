-- ============================================================
-- 069_coverage_direction_semantics.sql
-- Canonical business semantics + DB enforcement for domestic Yemen coverage.
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
--
-- Draft rows may be incomplete while an operator is entering data. Once both
-- domestic region ids are present their direction must already agree with the
-- table type, and a row cannot become operational without both legs.
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
set search_path = public, pg_temp
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

-- ------------------------------------------------------------
-- Database guardrail
-- ------------------------------------------------------------
-- We deliberately enforce this below the AI/application layer too. This keeps
-- admin UI, imports, scripts, RPCs and future code paths from persisting a
-- domestic offer/request in the opposite table.
create or replace function public.enforce_coverage_domestic_direction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scope text;
  v_pay_region_text text;
  v_receive_region_text text;
  v_pay_region_id uuid;
  v_receive_region_id uuid;
  v_pay_macro text;
  v_receive_macro text;
  v_actual_type text;
  v_expected_type text;
begin
  v_scope := coalesce(nullif(new.attributes ->> 'coverage_scope', ''), 'domestic');

  -- International coverage has a separate policy and is intentionally not
  -- forced into the domestic north/south rule.
  if v_scope <> 'domestic' then
    return new;
  end if;

  v_pay_region_text := nullif(new.attributes ->> 'pay_region_id', '');
  v_receive_region_text := nullif(new.attributes ->> 'receive_region_id', '');

  -- Incomplete drafts are allowed so operators can save work in progress.
  -- Operational rows must have both legs before they can participate.
  if v_pay_region_text is null or v_receive_region_text is null then
    if new.status in ('active', 'partially_reserved', 'fully_reserved', 'fulfilled') then
      raise exception using
        errcode = '23514',
        message = 'Domestic coverage requires both customer pay_region_id and receive_region_id before activation.',
        detail = format('table=%s status=%s', tg_table_name, new.status),
        hint = 'PAY south + RECEIVE north = offer; PAY north + RECEIVE south = request.';
    end if;
    return new;
  end if;

  begin
    v_pay_region_id := v_pay_region_text::uuid;
    v_receive_region_id := v_receive_region_text::uuid;
  exception when invalid_text_representation then
    raise exception using
      errcode = '23514',
      message = 'Coverage pay_region_id and receive_region_id must be valid UUIDs.';
  end;

  select r.macro_region
    into v_pay_macro
    from public.coverage_regions r
   where r.id = v_pay_region_id
     and r.account_id = new.account_id;

  if v_pay_macro is null then
    raise exception using
      errcode = '23514',
      message = 'Coverage pay region does not exist in this account.',
      detail = v_pay_region_text;
  end if;

  select r.macro_region
    into v_receive_macro
    from public.coverage_regions r
   where r.id = v_receive_region_id
     and r.account_id = new.account_id;

  if v_receive_macro is null then
    raise exception using
      errcode = '23514',
      message = 'Coverage receive region does not exist in this account.',
      detail = v_receive_region_text;
  end if;

  v_actual_type := case
    when v_pay_macro = 'south' and v_receive_macro = 'north' then 'offer'
    when v_pay_macro = 'north' and v_receive_macro = 'south' then 'request'
    else null
  end;

  v_expected_type := case tg_table_name
    when 'coverage_offers' then 'offer'
    when 'coverage_requests' then 'request'
    else null
  end;

  if v_actual_type is null then
    raise exception using
      errcode = '23514',
      message = 'Domestic coverage must cross the north/south corridor.',
      detail = format('pay_macro=%s receive_macro=%s', v_pay_macro, v_receive_macro),
      hint = 'Same-market and international directions are not classified by the domestic coverage rule.';
  end if;

  if v_expected_type is null or v_actual_type <> v_expected_type then
    raise exception using
      errcode = '23514',
      message = 'Coverage row type conflicts with the customer pay/receive direction.',
      detail = format(
        'table=%s expected=%s actual=%s pay_macro=%s receive_macro=%s',
        tg_table_name,
        coalesce(v_expected_type, 'unknown'),
        v_actual_type,
        v_pay_macro,
        v_receive_macro
      ),
      hint = 'PAY south + RECEIVE north must be coverage_offers; PAY north + RECEIVE south must be coverage_requests.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_coverage_domestic_direction() from public;
revoke all on function public.enforce_coverage_domestic_direction() from anon;
revoke all on function public.enforce_coverage_domestic_direction() from authenticated;

drop trigger if exists coverage_offers_direction_guard on public.coverage_offers;
create trigger coverage_offers_direction_guard
  before insert or update of attributes, status, account_id
  on public.coverage_offers
  for each row execute function public.enforce_coverage_domestic_direction();

drop trigger if exists coverage_requests_direction_guard on public.coverage_requests;
create trigger coverage_requests_direction_guard
  before insert or update of attributes, status, account_id
  on public.coverage_requests
  for each row execute function public.enforce_coverage_domestic_direction();

comment on function public.enforce_coverage_domestic_direction() is
  'DB guardrail: domestic complete offer rows must be customer SOUTH->NORTH; domestic complete request rows must be customer NORTH->SOUTH. Operational rows require both region ids.';
