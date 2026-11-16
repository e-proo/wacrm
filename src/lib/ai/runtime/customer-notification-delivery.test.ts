import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ config: null as string | null, owner: null as string | null }))
vi.mock('../admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: table === 'whatsapp_config' ? (h.config ? { user_id: h.config } : null) : (h.owner ? { owner_user_id: h.owner } : null), error: null }),
      }
      return q
    },
  }),
}))
import { loadWhatsAppDeliveryOwner } from './customer-notification-delivery'
describe('business outcome audit identity for both WhatsApp transports', () => {
  beforeEach(() => { h.config = null; h.owner = null })
  it('preserves Meta config owner when available', async () => {
    h.config = 'meta-owner'
    expect(await loadWhatsAppDeliveryOwner('account-1')).toEqual({ user_id: 'meta-owner' })
  })
  it('supports OpenWA-only accounts using the account owner', async () => {
    h.owner = 'account-owner'
    expect(await loadWhatsAppDeliveryOwner('account-1')).toEqual({ user_id: 'account-owner' })
  })
  it('fails closed when no account-scoped owner exists', async () => {
    await expect(loadWhatsAppDeliveryOwner('account-1')).rejects.toThrow('WHATSAPP_ACCOUNT_OWNER_MISSING')
  })
})
