import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from '../defaults'
import { localizedAdminFallback, localizedHandoffAcknowledgement } from './handoff-service'

describe('multi-agent runtime integration invariants', () => {
  it('uses an admin-specific prompt with no customer handoff sentinel', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', audience: 'admin' })
    expect(prompt).toContain('verified business administrator')
    expect(prompt).not.toContain(HANDOFF_SENTINEL)
    expect(prompt).not.toContain('customer-messaging assistant')
  })

  it('teaches customer mode to prefer native tools before handoff', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      audience: 'customer',
      nativeToolsAvailable: true,
      knowledge: ['some reference'],
    })
    expect(prompt).toContain(HANDOFF_SENTINEL)
    expect(prompt).toContain('use an offered System tool')
    expect(prompt).not.toContain('```tool')
  })

  it('localizes handoff/fallback messages', () => {
    expect(localizedHandoffAcknowledgement('مرحبا')).toContain('تم تحويل')
    expect(localizedHandoffAcknowledgement('hello')).toContain('team member')
    expect(localizedAdminFallback('ما هي التغطيات')).toContain('وكيل الإدارة')
  })

  it('bypasses customer reply slots for admin and wires human handoff', () => {
    const dispatch = readFileSync(new URL('./dispatch.ts', import.meta.url), 'utf8')
    expect(dispatch).toContain("if (decision.plane === 'customer')")
    expect(dispatch).toContain('admin plane bypasses customer reply cap')
    expect(dispatch).toContain('applyAgentHumanHandoff')
    expect(dispatch).toContain('localizedHandoffAcknowledgement')
  })

  it('recovers after an authoritative READ result', () => {
    const loop = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')
    expect(loop).toContain('hasAuthoritativeReadResult')
    expect(loop).toContain('recoverAfterAuthoritativeRead')
    expect(loop).toContain('[agent loop] tool=')
  })

  it('blocks broken admin/handoff publish configurations', () => {
    const builder = readFileSync(new URL('./builder-service.ts', import.meta.url), 'utf8')
    expect(builder).toContain('ADMIN_TOOL_ROUNDS_REQUIRED')
    expect(builder).toContain('HANDOFF_MEMBER_REQUIRED')
    expect(builder).toContain('HANDOFF_MEMBER_INVALID')
  })
})
