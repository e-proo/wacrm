import { describe, it, expect } from 'vitest'
import {
  isWithinBusinessHours,
  matchesConditions,
  pickAdminAgent,
  routeInboundMessage,
} from './router'
import type {
  AiAgent,
  AiAgentRevision,
  AiAgentRoute,
  ConversationAiState,
  RoutingContext,
  TrustedAdminIdentity,
} from './multi-agent-types'

// --- fixtures ------------------------------------------------------------

const ACCOUNT = 'acc-1'
const CONNECTION = 'conn-1'

function agent(over: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-cs',
    accountId: ACCOUNT,
    systemKey: 'customer_service',
    slug: 'customer-service',
    name: 'Customer Service',
    description: null,
    purpose: 'customer_support',
    status: 'active',
    publishedRevisionId: 'rev-cs',
    version: 1,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
    ...over,
  }
}

function revision(over: Partial<AiAgentRevision> = {}): AiAgentRevision {
  return {
    id: 'rev-cs',
    accountId: ACCOUNT,
    agentId: 'agent-cs',
    revisionNumber: 1,
    status: 'published',
    providerConnectionId: CONNECTION,
    model: 'gpt-4o-mini',
    systemPrompt: null,
    responseStyle: 'balanced',
    languagePolicy: 'auto',
    temperature: null,
    maxOutputTokens: null,
    maxToolRounds: 0,
    maxAiRepliesPerConversation: 3,
    handoffHumanMemberId: null,
    settings: {},
    createdAt: '2026-09-06T00:00:00Z',
    publishedAt: '2026-09-06T00:00:00Z',
    publishedBy: null,
    rejectionReason: null,
    ...over,
  }
}

function identity(
  over: Partial<TrustedAdminIdentity> & { normalizedAddress: string; status?: TrustedAdminIdentity['status'] },
): TrustedAdminIdentity {
  const normalizedAddress = over.normalizedAddress
  return {
    id: `id-${normalizedAddress}`,
    accountId: ACCOUNT,
    channel: 'whatsapp',
    normalizedAddress,
    displayName: null,
    memberId: null,
    status: over.status ?? 'active',
    verificationMethod: null,
    verifiedAt: null,
    revokedAt: null,
    allowedCapabilities: [],
    createdAt: '2026-09-06T00:00:00Z',
  }
}

function adminAgent(): AiAgent {
  return agent({
    id: 'agent-admin',
    systemKey: 'admin_operations',
    slug: 'admin-operations',
    name: 'Admin',
    purpose: 'admin_operations',
  })
}

function adminRevision(): AiAgentRevision {
  return revision({ id: 'rev-admin', agentId: 'agent-admin' })
}

function route(
  over: Partial<AiAgentRoute> & { routeKind: AiAgentRoute['routeKind']; agentId: string },
): AiAgentRoute {
  return {
    id: `route-${over.routeKind}-${over.agentId}`,
    accountId: ACCOUNT,
    name: over.routeKind,
    channel: 'whatsapp',
    priority: 100,
    isActive: true,
    conditions: {},
    stopProcessing: true,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
    ...over,
  }
}

function baseCtx(over: Partial<RoutingContext> = {}): RoutingContext {
  return {
    accountId: ACCOUNT,
    channel: 'whatsapp',
    senderAddress: '967777123456',
    conversationAiState: null,
    hasHumanAssignee: false,
    multiAgentEnabled: true,
    ...over,
  }
}

function baseLookup() {
  const lookup: {
    trustedIdentities: TrustedAdminIdentity[]
    routes: AiAgentRoute[]
    agents: { agent: AiAgent; revision: AiAgentRevision | null }[]
  } = {
    trustedIdentities: [],
    routes: [
      route({ routeKind: 'admin', agentId: 'agent-admin', priority: 200 }),
      route({ routeKind: 'default', agentId: 'agent-cs', priority: 50 }),
    ],
    agents: [
      { agent: agent(), revision: revision() },
      { agent: adminAgent(), revision: adminRevision() },
    ],
  }
  return lookup
}

// --- tests ---------------------------------------------------------------

describe('routeInboundMessage', () => {
  it('returns skip when multi-agent is disabled', () => {
    const decision = routeInboundMessage(
      baseCtx({ multiAgentEnabled: false }),
      baseLookup(),
    )
    expect(decision).toEqual({ action: 'skip', reason: 'multi_agent_disabled' })
  })

  it('routes trusted admin identity to admin plane BEFORE other gates', () => {
    const lookup = baseLookup()
    lookup.trustedIdentities = [identity({ normalizedAddress: '967777123456' })]
    const decision = routeInboundMessage(
      baseCtx({
        senderAddress: '967777123456',
        // Even with a human takeover + paused mode, admin wins.
        hasHumanAssignee: true,
        conversationAiState: {
          conversationId: 'conv-1',
          accountId: ACCOUNT,
          assignedAiAgentId: null,
          mode: 'human_only',
          pauseUntil: null,
          reason: null,
          version: 1,
          updatedAt: '2026-09-06T00:00:00Z',
        } as ConversationAiState,
      }),
      lookup,
    )
    expect(decision.action).toBe('route')
    if (decision.action === 'route') {
      expect(decision.plane).toBe('admin')
      expect(decision.agentId).toBe('agent-admin')
      expect(decision.revisionId).toBe('rev-admin')
    }
  })

  it('skips when sender is not a trusted admin and human owns the thread', () => {
    const decision = routeInboundMessage(
      baseCtx({ hasHumanAssignee: true }),
      baseLookup(),
    )
    expect(decision).toEqual({ action: 'skip', reason: 'human_takeover' })
  })

  it('skips when conversation is in handoff mode', () => {
    const decision = routeInboundMessage(
      baseCtx({
        conversationAiState: {
          conversationId: 'conv-1',
          accountId: ACCOUNT,
          assignedAiAgentId: null,
          mode: 'handoff',
          pauseUntil: null,
          reason: null,
          version: 1,
          updatedAt: '2026-09-06T00:00:00Z',
        } as ConversationAiState,
      }),
      baseLookup(),
    )
    expect(decision).toEqual({ action: 'skip', reason: 'conversation_handoff' })
  })

  it('routes to the explicitly-assigned agent', () => {
    const decision = routeInboundMessage(
      baseCtx({
        conversationAiState: {
          conversationId: 'conv-1',
          accountId: ACCOUNT,
          assignedAiAgentId: 'agent-cs',
          mode: 'auto',
          pauseUntil: null,
          reason: null,
          version: 1,
          updatedAt: '2026-09-06T00:00:00Z',
        } as ConversationAiState,
      }),
      baseLookup(),
    )
    expect(decision.action).toBe('route')
    if (decision.action === 'route') {
      expect(decision.agentId).toBe('agent-cs')
      expect(decision.reason).toBe('assigned_agent')
    }
  })

  it('falls through to the default route when no rule matches', () => {
    const decision = routeInboundMessage(baseCtx(), baseLookup())
    expect(decision.action).toBe('route')
    if (decision.action === 'route') {
      expect(decision.agentId).toBe('agent-cs')
      expect(decision.reason).toBe('default_route')
    }
  })

  it('skips with no_route_match when no admin identity and no default', () => {
    const lookup = baseLookup()
    lookup.routes = lookup.routes.filter((r) => r.routeKind !== 'default')
    const decision = routeInboundMessage(baseCtx(), lookup)
    expect(decision).toEqual({ action: 'skip', reason: 'no_route_match' })
  })

  it('refuses to route an agent that has no published revision', () => {
    const lookup = baseLookup()
    lookup.agents = lookup.agents.map((a) =>
      a.agent.id === 'agent-cs'
        ? { ...a, revision: null }
        : a,
    )
    const decision = routeInboundMessage(baseCtx(), lookup)
    expect(decision).toEqual({ action: 'skip', reason: 'no_route_match' })
  })
})

describe('pickAdminAgent', () => {
  it('matches a canonical address regardless of raw formatting', () => {
    const lookup = baseLookup()
    lookup.trustedIdentities = [identity({ normalizedAddress: '967777123456' })]
    const decision = pickAdminAgent('+967 777 123 456', lookup)
    expect(decision?.action).toBe('route')
    if (decision && decision.action === 'route') {
      expect(decision.plane).toBe('admin')
      expect(decision.reason).toContain('967777123456')
    }
  })

  it('ignores non-active identities (pending / revoked)', () => {
    const lookup = baseLookup()
    lookup.trustedIdentities = [
      identity({ normalizedAddress: '967777123456', status: 'pending_verification' }),
      identity({ normalizedAddress: '967777123456', status: 'revoked' }),
    ]
    expect(pickAdminAgent('967777123456', lookup)).toBeNull()
  })

  it('returns a documented skip when admin identity has no admin route', () => {
    const lookup = baseLookup()
    lookup.routes = lookup.routes.filter((r) => r.routeKind !== 'admin')
    lookup.trustedIdentities = [identity({ normalizedAddress: '967777123456' })]
    const decision = pickAdminAgent('967777123456', lookup)
    expect(decision).toEqual({
      action: 'skip',
      reason: 'admin_identity_no_admin_route',
    })
  })

  it('returns a documented skip when admin route target is not published', () => {
    const lookup = baseLookup()
    lookup.agents = lookup.agents.map((a) =>
      a.agent.id === 'agent-admin' ? { ...a, revision: null } : a,
    )
    lookup.trustedIdentities = [identity({ normalizedAddress: '967777123456' })]
    const decision = pickAdminAgent('967777123456', lookup)
    expect(decision).toEqual({
      action: 'skip',
      reason: 'admin_route_target_not_published',
    })
  })
})

describe('matchesConditions', () => {
  const ctx = baseCtx()

  it('returns true for empty conditions', () => {
    expect(matchesConditions(ctx, {})).toBe(true)
  })

  it('returns false when conditions require inbox_id (reserved)', () => {
    expect(matchesConditions(ctx, { inbox_id: 'whatever' })).toBe(false)
  })

  it('returns false when conditions require tags (reserved)', () => {
    expect(matchesConditions(ctx, { tags: ['vip'] })).toBe(false)
  })

  it('returns false when conditions require language (reserved)', () => {
    expect(matchesConditions(ctx, { language: 'ar' })).toBe(false)
  })
})

describe('isWithinBusinessHours', () => {
  // Wednesday 2026-09-09 in Asia/Aden (UTC+03): 09:30 local.
  const wedMorning = new Date('2026-09-09T06:30:00Z')

  it('matches a window that includes the current time', () => {
    expect(
      isWithinBusinessHours(
        {
          start: '09:00',
          end: '17:00',
          tz: 'Asia/Aden',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
        wedMorning,
      ),
    ).toBe(true)
  })

  it('rejects when current weekday is excluded', () => {
    expect(
      isWithinBusinessHours(
        {
          start: '09:00',
          end: '17:00',
          tz: 'Asia/Aden',
          weekdays: [5, 6],
        },
        wedMorning,
      ),
    ).toBe(false)
  })

  it('rejects when outside the time window', () => {
    // 23:00 Asia/Aden == 20:00 UTC → outside.
    const lateNight = new Date('2026-09-09T20:00:00Z')
    expect(
      isWithinBusinessHours(
        {
          start: '09:00',
          end: '17:00',
          tz: 'Asia/Aden',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
        lateNight,
      ),
    ).toBe(false)
  })

  it('rejects malformed windows', () => {
    expect(
      isWithinBusinessHours(
        {
          start: 'bad',
          end: '17:00',
          tz: 'Asia/Aden',
          weekdays: [],
        },
        wedMorning,
      ),
    ).toBe(false)
  })
})
