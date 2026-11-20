import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getWhatsAppAdminCopy } from './whatsapp-admin-copy'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, member]) => keys(member, prefix ? prefix + '.' + key : key)).sort()
}

describe('W07-05 operator administration UX', () => {
  it('has complete Arabic/English copy parity for all tabs, errors, status and safety reasons', () => {
    const ar = getWhatsAppAdminCopy('ar-YE')
    const en = getWhatsAppAdminCopy('en')
    expect(keys(ar)).toEqual(keys(en))
    expect(Object.values(ar.tabs)).toHaveLength(6)
    for (const dict of [ar, en]) {
      for (const value of Object.values(dict.ops.reasons)) expect(value.trim()).not.toBe('')
      for (const value of Object.values(dict.ops.errors)) expect(value.trim()).not.toBe('')
      expect(dict.ops.pendingDesc).not.toBe('')
      expect(dict.ops.noApprovedText).not.toBe('')
    }
  })

  it('has navigable top-level tabs and separates OpenWA session/Pilot/delivery render regions', () => {
    const dashboard = readFileSync('src/components/settings/whatsapp-config.tsx', 'utf8')
    const connections = readFileSync('src/components/settings/openwa-connections.tsx', 'utf8')
    for (const tab of ['overview','meta','sessions','pilot','governance','reviews']) {
      expect(dashboard).toContain('TabsTrigger value="' + tab + '"')
      expect(dashboard).toContain('TabsContent value="' + tab + '"')
    }
    expect(dashboard).toContain('{canEditSettings && <>')
    expect(dashboard).toContain('<OpenWAOperationalControlCenter />')
    expect(connections).toContain("view === 'sessions'")
    expect(connections).toContain("view === 'pilot'")
    expect(connections).toContain("view === 'delivery'")
    expect(connections.match(/<OpenWAOutboundReviewHub /g)).toHaveLength(1)
    expect(connections.match(/<OpenWAReconciliation /g)).toHaveLength(1)
  })

  it('never treats an accepted draft/TEST Pilot as production opt-in', () => {
    const center = readFileSync('src/components/settings/openwa-operational-control-center.tsx', 'utf8')
    const catalog = readFileSync('src/lib/whatsapp/transport/openwa/approved-policy-catalog.ts', 'utf8')
    const route = readFileSync('src/app/api/whatsapp/connections/openwa/operational-policy/route.ts', 'utf8')
    expect(center).toContain('data.policy.approved && Boolean(data.policy.terms)')
    expect(center).toContain('data.mutation_stage.owner_accept_available')
    expect(center).toContain('data.mutation_stage.connection_enable_available')
    expect(center).toContain('send_authorized: false')
    expect(center).toContain('crypto.randomUUID()')
    expect(center).toContain('requestRecord.current')
    expect(catalog).toContain('PUBLISHED_OPENWA_TERMS: readonly ApprovedOpenWATerms[] = []')
    expect(route).toContain('getApprovedOpenWATerms(body.policy_version, body.policy_digest)')
    expect(route).toContain('policy_terms_unavailable')
    expect(route).toContain('approved: false, version: null, digest: null, terms: null')
  })
})
