import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  completeFxTradeRequest: vi.fn(),
  cancelFxTradeRequest: vi.fn(),
  decideFxTradeRequest: vi.fn(),
  deliverActiveSubjectBusinessEventNotifications: vi.fn(),
  toFxApiError: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() =>
    Response.json({ error: 'rate limited' }, { status: 429 }),
  ),
  RATE_LIMITS: {
    adminAction: { windowMs: 1000, max: 10 },
  },
}))

vi.mock('@/lib/services/fx-v2/service', () => ({
  completeFxTradeRequest: mocks.completeFxTradeRequest,
  cancelFxTradeRequest: mocks.cancelFxTradeRequest,
  decideFxTradeRequest: mocks.decideFxTradeRequest,
}))

vi.mock('@/lib/services/fx-v2/http', () => ({
  toFxApiError: mocks.toFxApiError,
}))

vi.mock('@/lib/ai/runtime/customer-notification-delivery', () => ({
  deliverActiveSubjectBusinessEventNotifications:
    mocks.deliverActiveSubjectBusinessEventNotifications,
}))

import { PATCH } from './route'

const params = { params: Promise.resolve({ id: 'trade-1' }) }

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/fx-v2/trades/trade-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue({
    accountId: 'account-1',
    userId: 'admin-1',
    role: 'admin',
  })
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.completeFxTradeRequest.mockResolvedValue({
    requestId: 'trade-1',
    status: 'completed',
    idempotent: false,
  })
  mocks.cancelFxTradeRequest.mockResolvedValue({
    requestId: 'trade-1',
    status: 'cancelled',
    idempotent: false,
  })
  mocks.decideFxTradeRequest.mockResolvedValue({
    requestId: 'trade-1',
    status: 'approved_for_contact',
    idempotent: false,
  })
  mocks.deliverActiveSubjectBusinessEventNotifications.mockResolvedValue({
    claimed: 1,
    sent: 1,
    reconciliation: 0,
    failed: 0,
  })
  mocks.toFxApiError.mockImplementation((error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    ),
  )
})

describe('PATCH /api/fx-v2/trades/[id]', () => {
  it('flushes only the completed trade subject after authoritative completion', async () => {
    const response = await PATCH(request({ action: 'complete' }), params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      requestId: 'trade-1',
      status: 'completed',
      idempotent: false,
    })
    expect(mocks.completeFxTradeRequest).toHaveBeenCalledWith({
      accountId: 'account-1',
      requestId: 'trade-1',
      actorUserId: 'admin-1',
    })
    expect(
      mocks.deliverActiveSubjectBusinessEventNotifications,
    ).toHaveBeenCalledWith({
      accountId: 'account-1',
      subjectType: 'fx_trade_request',
      subjectId: 'trade-1',
      correlationId: null,
      limit: 10,
    })
  })

  it('passes the decision Change Request as correlation for an approval flush', async () => {
    const response = await PATCH(
      request({
        action: 'approve',
        changeRequestId: 'change-1',
        note: 'approved',
      }),
      params,
    )

    expect(response.status).toBe(200)
    expect(mocks.decideFxTradeRequest).toHaveBeenCalledWith({
      accountId: 'account-1',
      requestId: 'trade-1',
      expectedStatus: 'pending_admin',
      decision: 'approve',
      changeRequestId: 'change-1',
      note: 'approved',
      actorUserId: 'admin-1',
    })
    expect(
      mocks.deliverActiveSubjectBusinessEventNotifications,
    ).toHaveBeenCalledWith({
      accountId: 'account-1',
      subjectType: 'fx_trade_request',
      subjectId: 'trade-1',
      correlationId: 'change-1',
      limit: 10,
    })
  })

  it('does not fail an already-committed business mutation when immediate delivery fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.deliverActiveSubjectBusinessEventNotifications.mockRejectedValueOnce(
      new Error('transport unavailable'),
    )

    const response = await PATCH(request({ action: 'complete' }), params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      requestId: 'trade-1',
      status: 'completed',
    })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('does not attempt customer lifecycle delivery for cancel', async () => {
    const response = await PATCH(request({ action: 'cancel' }), params)

    expect(response.status).toBe(200)
    expect(mocks.cancelFxTradeRequest).toHaveBeenCalled()
    expect(
      mocks.deliverActiveSubjectBusinessEventNotifications,
    ).not.toHaveBeenCalled()
  })
})
