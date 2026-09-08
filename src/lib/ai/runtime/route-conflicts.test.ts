import { describe, it, expect } from 'vitest'
import { analyzeRouteConflicts } from './route-conflicts'
import type { AiAgent, AiAgentRoute } from './multi-agent-types'

function route(
  over: Partial<AiAgentRoute> & { id: string; routeKind: AiAgentRoute['routeKind'] },
): AiAgentRoute {
  return {
    accountId: 'acc-1',
    agentId: over.agentId ?? 'agent-1',
    name: over.name ?? over.id,
    channel: 'whatsapp',
    priority: 100,
    isActive: true,
    conditions: {},
    stopProcessing: true,
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
    ...over,
  }
}

function agent(
  over: Partial<Pick<AiAgent, 'id' | 'status' | 'purpose'>> & { id: string },
): Pick<AiAgent, 'id' | 'status' | 'purpose'> {
  return { status: 'active', purpose: 'customer_support', ...over }
}

const base = {
  routes: [] as AiAgentRoute[],
  agents: [] as Array<Pick<AiAgent, 'id' | 'status' | 'purpose'>>,
  hasActiveTrustedIdentity: true,
}

describe('analyzeRouteConflicts', () => {
  it('passes a clean setup with no conflicts', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [
        route({ id: 'r1', routeKind: 'admin', agentId: 'a1', priority: 200 }),
        route({ id: 'r2', routeKind: 'default', agentId: 'a1', priority: 50 }),
      ],
      agents: [agent({ id: 'a1' })],
    })
    expect(r).toEqual([])
  })

  it('flags DOUBLE_DEFAULT when two defaults share a channel', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [
        route({ id: 'd1', routeKind: 'default', agentId: 'a1', priority: 50 }),
        route({ id: 'd2', routeKind: 'default', agentId: 'a2', priority: 40 }),
      ],
      agents: [agent({ id: 'a1' }), agent({ id: 'a2' })],
    })
    const blocker = r.find((c) => c.code === 'DOUBLE_DEFAULT')
    expect(blocker?.severity).toBe('blocker')
    expect(blocker?.routeIds).toContain('d1')
    expect(blocker?.routeIds).toContain('d2')
  })

  it('flags ADMIN_WITHOUT_TRUSTED_IDENTITY when no identity verified', () => {
    const r = analyzeRouteConflicts({
      ...base,
      hasActiveTrustedIdentity: false,
      routes: [route({ id: 'adm', routeKind: 'admin', agentId: 'a1' })],
      agents: [agent({ id: 'a1', purpose: 'admin_operations' })],
    })
    const blocker = r.find((c) => c.code === 'ADMIN_WITHOUT_TRUSTED_IDENTITY')
    expect(blocker?.severity).toBe('blocker')
  })

  it('flags INDETERMINATE_TIE for same priority + same conditions', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [
        route({ id: 't1', routeKind: 'rule', agentId: 'a1', priority: 100, conditions: {} }),
        route({ id: 't2', routeKind: 'rule', agentId: 'a2', priority: 100, conditions: {} }),
      ],
      agents: [agent({ id: 'a1' }), agent({ id: 'a2' })],
    })
    const tie = r.find((c) => c.code === 'INDETERMINATE_TIE')
    expect(tie?.severity).toBe('blocker')
  })

  it('flags SHADOWED_RULE when a broad high-priority rule swallows a narrow one', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [
        route({
          id: 'broad',
          routeKind: 'rule',
          agentId: 'a1',
          priority: 200,
          conditions: { language: 'ar' },
        }),
        route({
          id: 'narrow',
          routeKind: 'rule',
          agentId: 'a2',
          priority: 100,
          conditions: { language: 'ar', inbox_id: 'inbox-1' },
        }),
      ],
      agents: [agent({ id: 'a1' }), agent({ id: 'a2' })],
    })
    const shadow = r.find((c) => c.code === 'SHADOWED_RULE')
    expect(shadow?.severity).toBe('warning')
    expect(shadow?.routeIds).toEqual(['broad', 'narrow'])
  })

  it('does not flag shadowing when priorities do not overlap', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [
        route({
          id: 'broad',
          routeKind: 'rule',
          agentId: 'a1',
          priority: 100,
          conditions: { language: 'ar' },
        }),
        route({
          id: 'narrow',
          routeKind: 'rule',
          agentId: 'a2',
          priority: 200,
          conditions: { language: 'ar', inbox_id: 'inbox-1' },
        }),
      ],
      agents: [agent({ id: 'a1' }), agent({ id: 'a2' })],
    })
    expect(r.find((c) => c.code === 'SHADOWED_RULE')).toBeUndefined()
  })

  it('flags PAUSED_TARGET as info for a default route to a paused agent', () => {
    const r = analyzeRouteConflicts({
      ...base,
      routes: [route({ id: 'd1', routeKind: 'default', agentId: 'paused-1' })],
      agents: [agent({ id: 'paused-1', status: 'paused' })],
    })
    const info = r.find((c) => c.code === 'PAUSED_TARGET')
    expect(info?.severity).toBe('info')
  })
})
