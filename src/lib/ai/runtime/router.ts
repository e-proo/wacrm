import { canonicalizeE164 } from './phone-e164'
import type {
  AiAgent,
  AiAgentRevision,
  AiAgentRoute,
  ConversationAiState,
  RoutingContext,
  RoutingDecision,
  RoutingSnapshot,
  RunPlane,
  TrustedAdminIdentity,
} from './multi-agent-types'

// ============================================================
// Pure routing function.
//
// Decides which AI agent handles an inbound message, or whether
// to skip the AI entirely. No DB / network — every input is the
// caller's responsibility to assemble. This is intentional: the
// same function runs in unit tests with hand-built snapshots, and
// inside the webhook after a single targeted read.
//
// Rule order (see plan 01_TARGET_ARCHITECTURE_AND_MIGRATION §6):
//   1. Trusted admin identity  → admin-plane agent (or skip).
//   2. Human takeover / paused  → skip.
//   3. Multi-agent disabled     → skip (caller should fall back
//                                  to the legacy ai_configs path).
//   4. Explicit assignment      → assigned agent's published rev.
//   5. Highest-priority active  → matching rule's agent.
//   6. Default route            → default agent for channel.
//   7. No path                  → skip with reason.
//
// All skip paths return a stable `reason` so the caller can log
// it; never throw — a routing decision is expected to be cheap.
// ============================================================

export interface RouteLookup {
  /** Active admin-plane identities for the account. */
  trustedIdentities: ReadonlyArray<TrustedAdminIdentity>
  /** Active routes ordered as the router will see them. */
  routes: ReadonlyArray<AiAgentRoute>
  /** Active agents + their published revision, joined. */
  agents: ReadonlyArray<{ agent: AiAgent; revision: AiAgentRevision | null }>
}

export interface RouteOptions {
  /** True when the legacy ai_configs path should win. The router
   *  returns a `skip` decision so the caller falls back. */
  multiAgentEnabled: boolean
  /** Whether a human teammate currently owns the conversation. */
  hasHumanAssignee: boolean
  /** Conversation AI state snapshot, or null when none exists. */
  conversationAiState: ConversationAiState | null
}

/**
 * Routing entry point. Returns either a `route` decision
 * (caller inserts a run row) or a `skip` decision with a stable
 * reason string suitable for the audit log.
 */
export function routeInboundMessage(
  ctx: RoutingContext,
  lookup: RouteLookup,
): RoutingDecision {
  // ------------------------------------------------------------
  // (1) Multi-agent gate. The runtime should never even reach
  // here when the flag is off, but we defend at the function
  // boundary so a regression in the caller can't accidentally
  // short-circuit into the new schema while the legacy path is
  // still authoritative.
  // ------------------------------------------------------------
  if (!ctx.multiAgentEnabled) {
    return { action: 'skip', reason: 'multi_agent_disabled' }
  }

  // ------------------------------------------------------------
  // (2) Admin-plane gate. Trusted identities are checked FIRST,
  // before human-takeover / pause gates, so a message from an
  // admin address is always delivered to the admin agent even if
  // the conversation was previously handed off to a human.
  // ------------------------------------------------------------
  const adminDecision = pickAdminAgent(ctx.senderAddress, lookup)
  if (adminDecision) return adminDecision

  // ------------------------------------------------------------
  // (3) Human takeover / pause gates.
  // ------------------------------------------------------------
  if (ctx.hasHumanAssignee) {
    return { action: 'skip', reason: 'human_takeover' }
  }
  const mode = ctx.conversationAiState?.mode ?? 'auto'
  if (mode === 'human_only') {
    return { action: 'skip', reason: 'conversation_human_only' }
  }
  if (mode === 'ai_paused' || mode === 'handoff') {
    return { action: 'skip', reason: `conversation_${mode}` }
  }

  // ------------------------------------------------------------
  // (4) Explicit assignment (if still active + published).
  // ------------------------------------------------------------
  if (ctx.conversationAiState?.assignedAiAgentId) {
    const assigned = findActiveAgent(
      lookup.agents,
      ctx.conversationAiState.assignedAiAgentId,
    )
    if (assigned) {
      return {
        action: 'route',
        plane: 'customer',
        agentId: assigned.agent.id,
        revisionId: assigned.revision.id,
        providerConnectionId: assigned.revision.providerConnectionId,
        reason: 'assigned_agent',
        routeId: null,
      }
    }
  }

  // ------------------------------------------------------------
  // (5 + 6) Rule match (highest priority wins), then default.
  // ------------------------------------------------------------
  const rule = pickRule(ctx, lookup.routes, lookup.agents)
  if (rule) return rule

  return { action: 'skip', reason: 'no_route_match' }
}

// ------------------------------------------------------------
// Helpers (exported for unit tests; not part of the public API)
// ------------------------------------------------------------

export function pickAdminAgent(
  senderAddress: string,
  lookup: RouteLookup,
): RoutingDecision | null {
  const canonical = canonicalizeE164(senderAddress)
  if (!canonical) return null
  const identity = lookup.trustedIdentities.find(
    (i) =>
      i.status === 'active' &&
      i.channel === 'whatsapp' &&
      i.normalizedAddress === canonical,
  )
  if (!identity) return null

  // Admin identity verified → look for the active admin route. We
  // use the highest-priority active admin route for the channel.
  const adminRoute = lookup.routes
    .filter(
      (r) =>
        r.isActive &&
        r.routeKind === 'admin' &&
        r.channel === 'whatsapp',
    )
    .slice()
    .sort((a, b) => b.priority - a.priority)[0]

  if (!adminRoute) {
    return {
      action: 'skip',
      reason: 'admin_identity_no_admin_route',
    }
  }

  const target = findActiveAgent(lookup.agents, adminRoute.agentId)
  if (!target || !target.revision) {
    return {
      action: 'skip',
      reason: 'admin_route_target_not_published',
    }
  }
  return {
    action: 'route',
    plane: 'admin',
    agentId: target.agent.id,
    revisionId: target.revision.id,
    providerConnectionId: target.revision.providerConnectionId,
    reason: `trusted_admin:${identity.normalizedAddress}`,
    routeId: adminRoute.id,
  }
}

function pickRule(
  ctx: RoutingContext,
  routes: ReadonlyArray<AiAgentRoute>,
  agents: ReadonlyArray<{ agent: AiAgent; revision: AiAgentRevision | null }>,
): RoutingDecision | null {
  const rules = routes
    .filter((r) => r.isActive && r.routeKind === 'rule' && r.channel === ctx.channel)
    .slice()
    .sort((a, b) => b.priority - a.priority)

  let softMatch: RoutingDecision | null = null
  for (const route of rules) {
    if (!matchesConditions(ctx, route.conditions)) continue
    const target = findActiveAgent(agents, route.agentId)
    if (!target || !target.revision) continue
    const decision: RoutingDecision = {
      action: 'route',
      plane: 'customer',
      agentId: target.agent.id,
      revisionId: target.revision.id,
      providerConnectionId: target.revision.providerConnectionId,
      reason: `rule:${route.name}`,
      routeId: route.id,
    }
    // stop_processing is now meaningful: a hard match wins immediately;
    // a soft match remains a candidate while lower-priority rules may refine
    // the decision. A default never outranks a matching rule.
    if (route.stopProcessing) return decision
    if (!softMatch) softMatch = decision
  }
  if (softMatch) return softMatch

  const defaults = routes
    .filter((r) => r.isActive && r.routeKind === 'default' && r.channel === ctx.channel)
    .slice()
    .sort((a, b) => b.priority - a.priority)
  for (const route of defaults) {
    const target = findActiveAgent(agents, route.agentId)
    if (!target || !target.revision) continue
    return {
      action: 'route',
      plane: 'customer',
      agentId: target.agent.id,
      revisionId: target.revision.id,
      providerConnectionId: target.revision.providerConnectionId,
      reason: 'default_route',
      routeId: route.id,
    }
  }
  return null
}

/**
 * Conservative condition matcher. Tags / language / inbox are
 * exact matches when provided; business-hours is a same-day
 * window in the route's IANA timezone. Unknown keys never match
 * (defensive — see plan §7 "no code-free condition").
 */
export function matchesConditions(
  ctx: RoutingContext,
  conditions: AiAgentRoute['conditions'],
): boolean {
  if (conditions.inbox_id) {
    if (!ctx.inboxId || ctx.inboxId !== conditions.inbox_id) return false
  }
  if (conditions.tags && conditions.tags.length > 0) {
    const actual = new Set(
      (ctx.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()),
    )
    // Conditions combine with AND semantics. This is deliberately
    // restrictive: a route that asks for multiple tags must see them all.
    if (
      !conditions.tags.every((tag) =>
        actual.has(tag.trim().toLocaleLowerCase()),
      )
    ) {
      return false
    }
  }
  if (conditions.language) {
    if (
      !ctx.language ||
      ctx.language.toLocaleLowerCase() !==
        conditions.language.trim().toLocaleLowerCase()
    ) {
      return false
    }
  }
  if (conditions.business_hours) {
    if (!isWithinBusinessHours(conditions.business_hours, new Date())) {
      return false
    }
  }
  return true
}

/**
 * Pure business-hours check. `now` is injected for testability.
 * Uses Intl.DateTimeFormat for IANA tz support.
 */
export function isWithinBusinessHours(
  window: NonNullable<AiAgentRoute['conditions']['business_hours']>,
  now: Date,
): boolean {
  const { start, end, tz, weekdays } = window
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    return false
  }
  // Get weekday + HH:MM in the route's timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const weekday = weekdayMap[weekdayStr]
  if (weekday === undefined) return false
  if (weekdays.length > 0 && !weekdays.includes(weekday)) return false
  const hhmm = `${parts.find((p) => p.type === 'hour')?.value ?? '00'}:${parts.find((p) => p.type === 'minute')?.value ?? '00'}`
  // Half-open interval: [start, end). Crosses midnight are not
  // supported in Phase 1 — keep the surface narrow.
  return hhmm >= start && hhmm < end
}

function findActiveAgent(
  agents: ReadonlyArray<{ agent: AiAgent; revision: AiAgentRevision | null }>,
  agentId: string,
): { agent: AiAgent; revision: AiAgentRevision } | null {
  const found = agents.find((a) => a.agent.id === agentId)
  if (!found) return null
  if (found.agent.status !== 'active') return null
  if (!found.revision) return null
  if (found.revision.status !== 'published') return null
  return { agent: found.agent, revision: found.revision }
}

// Re-export so consumers can import everything from one place.
export type { RoutingContext, RoutingDecision, RoutingSnapshot, RunPlane }
