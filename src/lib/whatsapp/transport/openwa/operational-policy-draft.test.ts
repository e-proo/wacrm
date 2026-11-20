import { describe, expect, it } from 'vitest'
import {
  OPENWA_POLICY_DRAFT,
  getOpenWAPolicyDraftCopy,
  proposedOpenWAPermission,
} from './operational-policy-draft'

describe('OW14-W07-00 draft provider consent contract', () => {
  it('does not treat preview or TEST pilot as production permission', () => {
    expect(OPENWA_POLICY_DRAFT).toMatchObject({
      state: 'draft',
      productionEnabledByDefault: false,
      pilotCountsAsConsent: false,
      reviewCreatesConsent: false,
    })
    expect(OPENWA_POLICY_DRAFT.version).toMatch(/^ow14-w07-draft-/)
  })

  it('reserves risk acceptance and revocation for the account owner', () => {
    expect(proposedOpenWAPermission('owner', 'accept')).toBe(true)
    expect(proposedOpenWAPermission('owner', 'revoke')).toBe(true)
    for (const role of ['admin', 'agent', 'viewer', null] as const) {
      expect(proposedOpenWAPermission(role, 'accept')).toBe(false)
      expect(proposedOpenWAPermission(role, 'revoke')).toBe(false)
    }
  })

  it('proposes admin+ connection control and denies unauthorized roles', () => {
    expect(proposedOpenWAPermission('owner', 'activate')).toBe(true)
    expect(proposedOpenWAPermission('admin', 'activate')).toBe(true)
    expect(proposedOpenWAPermission('agent', 'activate')).toBe(false)
    expect(proposedOpenWAPermission('viewer', 'activate')).toBe(false)
    expect(proposedOpenWAPermission(null, 'activate')).toBe(false)
    expect(proposedOpenWAPermission(null, 'review')).toBe(false)
  })

  it('keeps Arabic and English risk, steps and FAQ copy complete', () => {
    const ar = getOpenWAPolicyDraftCopy('ar-SA')
    const en = getOpenWAPolicyDraftCopy('en-US')
    expect(getOpenWAPolicyDraftCopy('pl')).toEqual(en)
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort())
    expect(ar.risks.length).toBeGreaterThanOrEqual(5)
    expect(ar.risks.length).toBe(en.risks.length)
    expect(ar.steps).toHaveLength(3)
    expect(en.steps).toHaveLength(3)
    expect(ar.faq.length).toBeGreaterThanOrEqual(5)
    expect(ar.faq.length).toBe(en.faq.length)
    for (const copy of [ar, en]) {
      for (const part of Object.values(copy)) {
        if (typeof part === 'string') expect(part.trim()).not.toBe('')
      }
      for (const group of [copy.risks, copy.steps, copy.faq]) {
        for (const entry of group) {
          for (const value of Object.values(entry)) expect(value.trim()).not.toBe('')
        }
      }
      for (const value of Object.values(copy.meta)) expect(value.trim()).not.toBe('')
      for (const value of Object.values(copy.openwa)) expect(value.trim()).not.toBe('')
      for (const value of Object.values(copy.consentBoundary)) expect(value.trim()).not.toBe('')
    }
  })

  it('states unofficial risks and consent distinctions in both languages', () => {
    const ar = getOpenWAPolicyDraftCopy('ar')
    const en = getOpenWAPolicyDraftCopy('en')
    const arRisks = ar.risks.map((x) => x.description).join(' ')
    const enRisks = en.risks.map((x) => x.description).join(' ')
    expect(arRisks).toContain('ليس واجهة Meta Cloud API الرسمية')
    expect(arRisks).toContain('موافقات المستلمين')
    expect(arRisks).toContain('timeout')
    expect(enRisks).toContain('not the official Meta Cloud API')
    expect(enRisks).toContain('recipient permissions')
    expect(enRisks).toContain('timeout')
    expect(ar.notice).toContain('لا تحفظ هذه الشاشة أي موافقة')
    expect(en.notice).toContain('saves no consent')
  })
})
