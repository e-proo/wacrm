import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./business-notifications.ts', import.meta.url), 'utf8')
const adminSection = source.split('interface CustomerNotificationRow')[0]

describe('trusted-admin approval notification transport contract', () => {
  it('renders change_request.pending through the messaging platform', () => {
    expect(adminSection).toContain('renderPendingChangeRequestAdminMessage')
    expect(adminSection).toContain('createSupabaseTemplateOverrideStore')
    expect(adminSection).toContain('event=change_request.pending')
  })

  it('does not persist the secret-bearing approval body through engineSendText', () => {
    expect(adminSection).not.toContain('engineSendText({')
    expect(adminSection).toContain('sendDirectTrustedAdminText({')
  })

  it('keeps durable in-app notification content PIN-free', () => {
    const inAppBlock = adminSection.slice(
      adminSection.indexOf('const linkedMemberIds'),
      adminSection.indexOf('// An idempotent create-change replay'),
    )
    expect(inAppBlock).not.toContain('confirmationCode')
    expect(inAppBlock).not.toContain('confirmation_code')
  })
})
