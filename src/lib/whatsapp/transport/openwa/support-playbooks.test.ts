import { describe, expect, it } from 'vitest'
import {
  OPENWA_SUPPORT_FAQS, OPENWA_SUPPORT_GUIDES, OPENWA_SUPPORT_PROCEDURES,
  OPENWA_SUPPORT_ROLES, OPENWA_SUPPORT_SEVERITIES, OPENWA_SUPPORT_TOPICS,
  findOpenWASupportProcedure, localizeSupport, searchOpenWASupport,
  type SupportText,
} from './support-playbooks'

const textIsComplete = (x: SupportText) => typeof x.ar === 'string' &&
  typeof x.en === 'string' && x.ar.trim().length > 2 && x.en.trim().length > 2

describe('OW14-W07-06 operator incident and bilingual help catalogue', () => {
  it('covers real WACRM outage, approval, delivery, identity, worker and security scenarios', () => {
    const ids = OPENWA_SUPPORT_PROCEDURES.map(i => i.id)
    expect(ids.length).toBeGreaterThanOrEqual(14)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      'session-disconnected','qr-relink','policy-not-approved','consent-stale',
      'test-schema-unavailable','send-restricted','ambiguous-outbound',
      'unmatched-ack','lid-unresolved','webhook-degraded','workers-overlap',
      'media-uncertain','credentials-risk','meta-not-ready','test-pilot-limits',
      'account-isolation',
    ]) expect(findOpenWASupportProcedure(id)?.id).toBe(id)
    expect(findOpenWASupportProcedure('undefined')).toBeNull()
  })
  it('has explicit severity, owner, navigation, safety warning, escalation and 3+ steps for each incident', () => {
    for (const item of OPENWA_SUPPORT_PROCEDURES) {
      expect(OPENWA_SUPPORT_TOPICS[item.topic]).toBeDefined()
      expect(OPENWA_SUPPORT_SEVERITIES[item.severity]).toBeDefined()
      expect(OPENWA_SUPPORT_ROLES[item.owner]).toBeDefined()
      expect(['meta','sessions','pilot','governance','reviews']).toContain(item.destination)
      expect(textIsComplete(item.title)).toBe(true)
      expect(textIsComplete(item.symptom)).toBe(true)
      expect(textIsComplete(item.avoid)).toBe(true)
      expect(textIsComplete(item.escalate)).toBe(true)
      expect(item.steps.length).toBeGreaterThanOrEqual(3)
      expect(item.steps.every(textIsComplete)).toBe(true)
    }
    for (const id of ['workers-overlap','credentials-risk','account-isolation']) {
      expect(findOpenWASupportProcedure(id)?.severity).toBe('p0')
    }
  })
  it('keeps guides, FAQs and topic catalog complete in Arabic and English', () => {
    expect(OPENWA_SUPPORT_GUIDES.length).toBeGreaterThanOrEqual(8)
    expect(OPENWA_SUPPORT_FAQS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(OPENWA_SUPPORT_GUIDES.map(i=>i.id)).size).toBe(OPENWA_SUPPORT_GUIDES.length)
    expect(new Set(OPENWA_SUPPORT_FAQS.map(i=>i.id)).size).toBe(OPENWA_SUPPORT_FAQS.length)
    for (const item of OPENWA_SUPPORT_GUIDES) {
      expect(textIsComplete(item.title)).toBe(true)
      expect(textIsComplete(item.description)).toBe(true)
      expect(item.steps.every(textIsComplete)).toBe(true)
      expect(item.steps.length).toBeGreaterThanOrEqual(3)
      expect(OPENWA_SUPPORT_TOPICS[item.topic]).toBeDefined()
    }
    for (const item of OPENWA_SUPPORT_FAQS) {
      expect(textIsComplete(item.question)).toBe(true)
      expect(textIsComplete(item.answer)).toBe(true)
      expect(OPENWA_SUPPORT_TOPICS[item.topic]).toBeDefined()
    }
    expect(localizeSupport({ar:'عربي',en:'English'},'ar-YE')).toBe('عربي')
    expect(localizeSupport({ar:'عربي',en:'English'},'en-GB')).toBe('English')
  })
  it('searches cross-language symptoms and known codes without changing policy', () => {
    expect(searchOpenWASupport('ar-YE','@lid').map(i => i.id)).toContain('lid-unresolved')
    expect(searchOpenWASupport('en','503').map(i => i.id)).toContain('test-schema-unavailable')
    expect(searchOpenWASupport('ar','ambiguous_outcome').map(i => i.id)).toContain('ambiguous-outbound')
    expect(searchOpenWASupport('en','تسريب').map(i => i.id)).toContain('credentials-risk')
    expect(searchOpenWASupport('en','', 'security').every(i => i.topic === 'security')).toBe(true)
    expect(searchOpenWASupport('ar','random-zero-match-invalid-phrase')).toEqual([])
  })
})
