import type { MessageContext } from './types'

export function formatMessageNumber(value: string | number, maximumFractionDigits = 6): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(numeric)
}

export function buildGenericServiceMessageContext(input: {
  entityType: string
  entityId?: string | null
  reference?: string | null
  status?: string | null
  statusLabel?: string | null
  serviceId?: string | null
  serviceCode?: string | null
  serviceName?: string | null
  customerId?: string | null
  customerName?: string | null
  amount?: string | number | null
  currency?: string | null
  summary?: string | null
  data?: MessageContext['data']
}): MessageContext {
  return {
    customer:
      input.customerId || input.customerName
        ? {
            ...(input.customerId ? { id: input.customerId } : {}),
            ...(input.customerName ? { name: input.customerName } : {}),
          }
        : undefined,
    entity: {
      type: input.entityType,
      ...(input.entityId ? { id: input.entityId } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.statusLabel ? { status_label: input.statusLabel } : {}),
    },
    service:
      input.serviceId || input.serviceCode || input.serviceName
        ? {
            ...(input.serviceId ? { id: input.serviceId } : {}),
            ...(input.serviceCode ? { code: input.serviceCode } : {}),
            ...(input.serviceName ? { name: input.serviceName } : {}),
          }
        : undefined,
    money:
      input.amount != null || input.currency
        ? {
            ...(input.amount != null ? { amount: formatMessageNumber(input.amount) } : {}),
            ...(input.currency ? { currency: input.currency } : {}),
          }
        : undefined,
    data: {
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.data ?? {}),
    },
  }
}

export function buildCoverageMessageContext(input: {
  entityType: 'coverage_offer' | 'coverage_request'
  entityId?: string | null
  reference?: string | null
  serviceId?: string | null
  serviceName?: string | null
  amount: string | number
  currency: string
  payRegion: string
  payMethod: string
  receiveRegion: string
  receiveMethod: string
  commissionAmount?: string | number | null
  commissionCurrency?: string | null
  commissionEffect?: 'customer_receives' | 'customer_pays' | null
}): MessageContext {
  const commissionLabel =
    input.commissionEffect === 'customer_receives'
      ? 'الراجع لك'
      : input.commissionEffect === 'customer_pays'
        ? 'العمولة عليك'
        : 'العمولة'

  const context = buildGenericServiceMessageContext({
    entityType: input.entityType,
    entityId: input.entityId,
    reference: input.reference,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    amount: input.amount,
    currency: input.currency,
    data: {
      pay_region: input.payRegion,
      pay_method: input.payMethod,
      receive_region: input.receiveRegion,
      receive_method: input.receiveMethod,
      commission_label: commissionLabel,
    },
  })

  if (input.commissionAmount != null) {
    context.money = {
      ...(context.money ?? {}),
      commission: formatMessageNumber(input.commissionAmount),
      commission_currency: input.commissionCurrency ?? input.currency,
    }
  }
  return context
}

export function buildExchangeRateMessageContext(input: {
  entityId?: string | null
  reference?: string | null
  baseCurrency: string
  quoteCurrency: string
  buyRate: string | number
  sellRate: string | number
  marketLabel?: string | null
  rateUnitLabel?: string | null
}): MessageContext {
  return buildGenericServiceMessageContext({
    entityType: 'exchange_rate',
    entityId: input.entityId,
    reference: input.reference,
    data: {
      base_currency: input.baseCurrency,
      quote_currency: input.quoteCurrency,
      buy_rate: formatMessageNumber(input.buyRate),
      sell_rate: formatMessageNumber(input.sellRate),
      ...(input.marketLabel ? { market_label: input.marketLabel } : {}),
      ...(input.rateUnitLabel ? { rate_unit_label: input.rateUnitLabel } : {}),
    },
  })
}

export function buildFxTradeMessageContext(input: {
  entityId: string
  reference: string
  status: string
  side: 'customer_buy' | 'customer_sell'
  amountBasis: 'base' | 'quote'
  requestedAmount: string | number
  effectiveRate: string | number
  baseAmount: string | number
  quoteAmount: string | number
  baseCurrency: string
  quoteCurrency: string
  rateVersionId: string
}): MessageContext {
  const requestedCurrency = input.amountBasis === 'base' ? input.baseCurrency : input.quoteCurrency
  const sideLabel = input.side === 'customer_buy' ? `شراء ${input.baseCurrency}` : `بيع ${input.baseCurrency}`
  return buildGenericServiceMessageContext({
    entityType: 'fx_trade_request',
    entityId: input.entityId,
    reference: input.reference,
    status: input.status,
    amount: input.requestedAmount,
    currency: requestedCurrency,
    data: {
      pair: `${input.baseCurrency}/${input.quoteCurrency}`,
      side: input.side,
      side_label: sideLabel,
      amount_basis: input.amountBasis,
      effective_rate: formatMessageNumber(input.effectiveRate),
      base_amount: formatMessageNumber(input.baseAmount),
      base_currency: input.baseCurrency,
      quote_amount: formatMessageNumber(input.quoteAmount),
      quote_currency: input.quoteCurrency,
      rate_version_id: input.rateVersionId,
    },
  })
}

export function buildRemittanceMessageContext(input: {
  entityId?: string | null
  reference?: string | null
  serviceId?: string | null
  serviceName?: string | null
  amount: string | number
  currency: string
  beneficiaryName?: string | null
  destination?: string | null
  deliveryMethod?: string | null
}): MessageContext {
  return buildGenericServiceMessageContext({
    entityType: 'remittance',
    entityId: input.entityId,
    reference: input.reference,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    amount: input.amount,
    currency: input.currency,
    data: {
      ...(input.beneficiaryName ? { beneficiary_name: input.beneficiaryName } : {}),
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.deliveryMethod ? { delivery_method: input.deliveryMethod } : {}),
    },
  })
}
