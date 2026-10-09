// ============================================================
// Coverage business direction — canonical north/south semantics.
//
// IMPORTANT BUSINESS RULE
// -----------------------
// The Arabic words "راجع" and "عمولة" do NOT describe two
// different fee products. They describe who receives/pays the same
// per-thousand coverage commission, and that is determined ONLY by
// where the customer pays and where the customer wants the money.
//
//   customer PAYS in SOUTH + RECEIVES in NORTH
//     => COVERAGE OFFER
//     => commission is RETURNED TO the customer ("راجع للعميل")
//
//   customer PAYS in NORTH + RECEIVES in SOUTH
//     => COVERAGE REQUEST
//     => commission is PAID BY the customer ("عمولة")
//
// Methods (cash, networks, bank deposit, remittance) describe the
// two legs but do not flip offer/request direction.
// ============================================================

export type CoverageMacroRegion = 'north' | 'south' | 'international'
export type CoverageBusinessKind = 'offer' | 'request'
export type CoverageCommissionEffect = 'customer_receives' | 'customer_pays'

export interface CoverageDirectionDecision {
  supported: boolean
  kind: CoverageBusinessKind | null
  commissionEffect: CoverageCommissionEffect | null
  customerTermAr: 'راجع للعميل' | 'عمولة' | null
  /** Market column used by the published coverage rate board. */
  rateMarket: 'north' | 'south' | null
  code:
    | 'SOUTH_TO_NORTH_OFFER'
    | 'NORTH_TO_SOUTH_REQUEST'
    | 'SAME_MARKET_NOT_CROSS_COVERAGE'
    | 'INTERNATIONAL_DIRECTION_REQUIRES_POLICY'
    | 'DIRECTION_INCOMPLETE'
  explanationAr: string
}

export function classifyCoverageDirection(
  payMacro: CoverageMacroRegion | null | undefined,
  receiveMacro: CoverageMacroRegion | null | undefined,
): CoverageDirectionDecision {
  if (!payMacro || !receiveMacro) {
    return {
      supported: false,
      kind: null,
      commissionEffect: null,
      customerTermAr: null,
      rateMarket: null,
      code: 'DIRECTION_INCOMPLETE',
      explanationAr: 'يلزم تحديد منطقة دفع العميل ومنطقة استلامه قبل تصنيف التغطية.',
    }
  }

  if (payMacro === 'south' && receiveMacro === 'north') {
    return {
      supported: true,
      kind: 'offer',
      commissionEffect: 'customer_receives',
      customerTermAr: 'راجع للعميل',
      rateMarket: 'north',
      code: 'SOUTH_TO_NORTH_OFFER',
      explanationAr:
        'العميل يدفع في الجنوب ويستلم في الشمال؛ هذه عرض تغطية والعمولة راجعة للعميل.',
    }
  }

  if (payMacro === 'north' && receiveMacro === 'south') {
    return {
      supported: true,
      kind: 'request',
      commissionEffect: 'customer_pays',
      customerTermAr: 'عمولة',
      rateMarket: 'south',
      code: 'NORTH_TO_SOUTH_REQUEST',
      explanationAr:
        'العميل يدفع في الشمال ويستلم في الجنوب؛ هذه طلب تغطية والعمولة يدفعها العميل.',
    }
  }

  if (payMacro === receiveMacro) {
    return {
      supported: false,
      kind: null,
      commissionEffect: null,
      customerTermAr: null,
      rateMarket: null,
      code: 'SAME_MARKET_NOT_CROSS_COVERAGE',
      explanationAr:
        'الدفع والاستلام في نفس السوق لا يطابق مسار تغطيات الشمال↔الجنوب ويحتاج خدمة/سياسة أخرى.',
    }
  }

  return {
    supported: false,
    kind: null,
    commissionEffect: null,
    customerTermAr: null,
    rateMarket: null,
    code: 'INTERNATIONAL_DIRECTION_REQUIRES_POLICY',
    explanationAr:
      'أحد طرفي العملية دولي؛ لا تُطبق قاعدة عرض/طلب الشمال↔الجنوب تلقائيًا دون سياسة التغطية الدولية.',
  }
}

export function coverageDirectionRuleSummary(): string {
  return [
    'Coverage direction is determined by the customer legs, never by the words offer/request/commission.',
    'PAY south + RECEIVE north => offer; commission effect = customer_receives; Arabic term = راجع للعميل.',
    'PAY north + RECEIVE south => request; commission effect = customer_pays; Arabic term = عمولة.',
    'Cash/networks/remittance/bank-deposit are leg methods and do not reverse this classification.',
  ].join(' ')
}
