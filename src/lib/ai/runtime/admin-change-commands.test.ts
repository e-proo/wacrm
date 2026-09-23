import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  approveChangeRequestFromTrustedAdmin: vi.fn(),
  rejectChangeRequest: vi.fn(),
  executeApprovedChangeRequest: vi.fn(),
  deliverCustomerOutcomeNotifications: vi.fn(),
  renderChangeRequestAdminOutcomeMessage: vi.fn(),
  createSupabaseTemplateOverrideStore: vi.fn(() => ({ store: true })),
  maybeSingle: vi.fn(),
  supabaseAdmin: vi.fn(),
}))

vi.mock('./change-requests-service', () => ({
  approveChangeRequestFromTrustedAdmin:
    mocks.approveChangeRequestFromTrustedAdmin,
  rejectChangeRequest: mocks.rejectChangeRequest,
}))

vi.mock('./change-request-executor', () => ({
  executeApprovedChangeRequest: mocks.executeApprovedChangeRequest,
}))

vi.mock('./customer-notification-delivery', () => ({
  deliverCustomerOutcomeNotifications:
    mocks.deliverCustomerOutcomeNotifications,
}))

vi.mock('@/lib/messaging/change-request-admin-outcome', () => ({
  renderChangeRequestAdminOutcomeMessage:
    mocks.renderChangeRequestAdminOutcomeMessage,
}))

vi.mock('@/lib/messaging/supabase-store', () => ({
  createSupabaseTemplateOverrideStore:
    mocks.createSupabaseTemplateOverrideStore,
}))

vi.mock('../admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { handleAdminChangeCommand } from './admin-change-commands'
import type { TrustedAdminIdentity } from './multi-agent-types'

function installDb() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.maybeSingle,
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  mocks.supabaseAdmin.mockReturnValue({
    from: vi.fn().mockReturnValue(query),
  })
}

const identity: TrustedAdminIdentity = {
  id: 'identity-1',
  accountId: 'account-1',
  channel: 'whatsapp',
  normalizedAddress: '+967700000000',
  displayName: 'Admin',
  memberId: 'member-1',
  status: 'active',
  verificationMethod: 'otp',
  verifiedAt: '2026-09-24T00:00:00.000Z',
  revokedAt: null,
  allowedCapabilities: ['change_requests.approve'],
  createdAt: '2026-09-24T00:00:00.000Z',
}

describe('trusted-admin change commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installDb()
    mocks.rejectChangeRequest.mockResolvedValue({ status: 'rejected' })
    mocks.deliverCustomerOutcomeNotifications.mockResolvedValue({
      claimed: 1,
      sent: 1,
      reconciliation: 0,
      failed: 0,
    })
    mocks.renderChangeRequestAdminOutcomeMessage.mockResolvedValue({
      text: 'تم رفض CHG-73 وتم إشعار العميل.',
      source: 'system',
      resolvedEventKey: 'change_request.rejected',
      resolvedLocale: 'ar',
      revisionId: null,
      version: null,
      fallbackReason: null,
    })
  })

  it('rejects the original pending FX review directly without executing an approval', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        id: 'review-cr-1',
        status: 'pending',
        target_type: 'fx_trade_request',
        summary: 'مراجعة طلب صرف',
        proposed_payload: {
          expected_status: 'pending_admin',
          decision: 'approve',
        },
      },
      error: null,
    })

    const result = await handleAdminChangeCommand({
      accountId: 'account-1',
      identity,
      inboundMessageId: 'message-1',
      text: 'رفض CHG-73 غير مناسب',
    })

    expect(mocks.rejectChangeRequest).toHaveBeenCalledWith({
      accountId: 'account-1',
      changeRequestId: 'review-cr-1',
      actorUserId: 'member-1',
      reason: 'غير مناسب',
    })
    expect(mocks.executeApprovedChangeRequest).not.toHaveBeenCalled()
    expect(mocks.deliverCustomerOutcomeNotifications).toHaveBeenCalledWith({
      accountId: 'account-1',
      changeRequestId: 'review-cr-1',
    })
    expect(mocks.renderChangeRequestAdminOutcomeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        changeRequestId: 'review-cr-1',
        requestCode: 73,
        outcome: 'rejected',
        targetType: 'fx_trade_request',
      }),
    )
    expect(result).toEqual({
      handled: true,
      reply: 'تم رفض CHG-73 وتم إشعار العميل.',
    })
  })
})
