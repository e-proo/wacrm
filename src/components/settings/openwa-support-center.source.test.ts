import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OW14-W07-06 help center UI safety and navigation contracts', () => {
  const config = readFileSync('src/components/settings/whatsapp-config.tsx','utf8')
  const support = readFileSync('src/components/settings/openwa-support-center.tsx','utf8')
  const diag = readFileSync('src/lib/whatsapp/transport/openwa/support-diagnostics.ts','utf8')
  it('exposes a seventh tab and a working overview shortcut, with lazy mounting', () => {
    for (const tab of ['overview','meta','sessions','pilot','governance','reviews','support']) {
      expect(config).toContain('TabsTrigger value="' + tab + '"')
      expect(config).toContain('TabsContent value="' + tab + '"')
    }
    expect(config).toContain("activeTab === 'support' && <OpenWASupportCenter")
    expect(config).toContain("openTab('support')")
    expect(config).toContain('onNavigate={tab => openTab(tab)}')
  })
  it('offers symptom search, incident checklist, guided runbooks, read-only diagnostics and FAQ', () => {
    for (const view of ['incidents','guides','diagnostics','faq']) {
      expect(support).toContain('TabsTrigger value="' + view + '"')
      expect(support).toContain('TabsContent value="' + view + '"')
    }
    expect(support).toContain('searchOpenWASupport(locale, query, topic)')
    expect(support).toContain('selected.steps.map')
    expect(support).toContain('OPENWA_SUPPORT_GUIDES.map')
    expect(support).toContain('OPENWA_SUPPORT_FAQS.map')
    expect(support).toContain('onClick={() => navigate(guide.destination)}')
    expect(support).toContain('onClick={() => navigate(selected.destination)}')
  })
  it('does not initiate a transport send, write credentials, auto-retry or fetch diagnostics in background', () => {
    expect(support).toContain("method: 'GET'")
    expect(support).toContain("credentials: 'same-origin'")
    expect(support).toContain("cache: 'no-store'")
    expect(support).toContain("AbortController()")
    expect(support).toContain('if (!canEditSettings || !accountId || diagnosing) return')
    expect(support).toContain('onClick={() => void checkStatus()}')
    expect(support).not.toContain("method: 'POST'")
    expect(support).not.toContain('sendText(')
    expect(support).not.toContain('sendMedia(')
    expect(support).not.toContain('localStorage.')
    expect(support).not.toContain('console.log(')
    expect(diag).not.toContain('JSON.stringify(operational.data)')
    expect(diag).not.toContain('JSON.stringify(sessions.data)')
    expect(diag).toContain('Never')
    expect(support).toContain('navigator.clipboard.writeText(')
    expect(support).toContain('formatOpenWASupportHandoff(')
    expect(support).toContain("result?.accountScope === (accountId || '') + ':' + canEditSettings")
    expect(support).toContain('const visibleResult =')
    expect(support).toContain('if (!visibleResult || !canEditSettings) return')
    expect(support).toContain('accountScope: accountId +')
    expect(diag).toContain('new Set(operationalIds).size')
    expect(diag).toContain('new Set(sessionIds).size')
    expect(diag).toContain("if (listsConsistent === false) suggestedProcedures.add('account-isolation')")
    expect(diag).toContain('trustedOps ? allowedOps.length : null')
  })
})
