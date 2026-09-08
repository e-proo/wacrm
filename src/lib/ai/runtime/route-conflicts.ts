// ============================================================
// Route conflict analyzer (Phase 4 §9).
//
// Pure function over a set of routes + agents. Classifies:
//   blocker — publishing is refused:
//     • two active defaults for the same channel,
//     • an admin-plane agent routed WITHOUT a trusted-admin
//       condition (the admin plane must never answer customer
//       numbers),
//     • two rules with identical priorities AND identical
//       condition sets for the same channel (indeterminate
//       ordering).
//   warning — suspicious but allowed:
//     • a broad rule shadowing a more specific one (same
//       conditions subset, lower priority → unreachable).
//   info — informational:
//     • a default route whose target agent is paused (falls
//       through to humans).
// ============================================================

import type { AiAgentRoute, AiAgent } from './multi-agent-types'

export type ConflictSeverity = 'blocker' | 'warning' | 'info'

export interface RouteConflict {
  severity: ConflictSeverity
  code: string
  message: string
  routeIds: string[]
}

export interface ConflictInput {
  routes: ReadonlyArray<AiAgentRoute>
  /** Agents keyed by id, for status checks. */
  agents: ReadonlyArray<Pick<AiAgent, 'id' | 'status' | 'purpose'>>
  /** Trusted-admin plane is only valid when at least one verified
   *  identity exists — the router refuses admin routing without one. */
  hasActiveTrustedIdentity: boolean
}

export function analyzeRouteConflicts(input: ConflictInput): RouteConflict[] {
  const conflicts: RouteConflict[] = []
  const { routes, agents, hasActiveTrustedIdentity } = input

  const active = routes.filter((r) => r.isActive)
  const agentById = new Map(agents.map((a) => [a.id, a]))

  // --- Blocker 1: two active defaults for the same channel -------
  const defaultsByChannel = new Map<string, AiAgentRoute[]>()
  for (const r of active) {
    if (r.routeKind !== 'default') continue
    const list = defaultsByChannel.get(r.channel) ?? []
    list.push(r)
    defaultsByChannel.set(r.channel, list)
  }
  for (const [, list] of defaultsByChannel) {
    if (list.length > 1) {
      conflicts.push({
        severity: 'blocker',
        code: 'DOUBLE_DEFAULT',
        message: `Two or more active default routes for channel "${list[0].channel}".`,
        routeIds: list.map((r) => r.id),
      })
    }
  }

  // --- Blocker 2: admin plane without a trusted identity ---------
  const adminRoutes = active.filter((r) => r.routeKind === 'admin')
  for (const r of adminRoutes) {
    if (!hasActiveTrustedIdentity) {
      conflicts.push({
        severity: 'blocker',
        code: 'ADMIN_WITHOUT_TRUSTED_IDENTITY',
        message:
          'Admin routes require at least one verified trusted-admin identity.',
        routeIds: [r.id],
      })
      break // one message is enough
    }
  }

  // --- Blocker 3: identical priority + identical conditions ------
  const rules = active.filter((r) => r.routeKind === 'rule')
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]
      const b = rules[j]
      if (a.channel !== b.channel) continue
      if (a.priority !== b.priority) continue
      if (JSON.stringify(a.conditions) !== JSON.stringify(b.conditions)) {
        continue
      }
      conflicts.push({
        severity: 'blocker',
        code: 'INDETERMINATE_TIE',
        message: `Rules "${a.name}" and "${b.name}" share priority ${a.priority} with identical conditions — ordering is indeterminate.`,
        routeIds: [a.id, b.id],
      })
    }
  }

  // --- Warning: broader rule shadows a more specific one ---------
  // The runtime evaluates in descending priority, so a rule is
  // unreachable when a HIGHER-priority rule matches every message
  // it would match — i.e. the higher rule's conditions are a
  // subset of the lower rule's conditions (it requires less).
  // The reverse order (specific above broad) is fine and common.
  for (const high of rules) {
    for (const low of rules) {
      if (high.id === low.id) continue
      if (high.channel !== low.channel) continue
      if (high.priority <= low.priority) continue
      if (!isSubset(high.conditions, low.conditions)) continue
      conflicts.push({
        severity: 'warning',
        code: 'SHADOWED_RULE',
        message: `"${high.name}" (priority ${high.priority}) shadows "${low.name}" (priority ${low.priority}) — the lower-priority rule can never fire.`,
        routeIds: [high.id, low.id],
      })
    }
  }

  // --- Info: default whose target agent is paused ----------------
  for (const r of active) {
    const agent = agentById.get(r.agentId)
    if (!agent) continue
    if (agent.status === 'paused') {
      conflicts.push({
        severity: 'info',
        code: 'PAUSED_TARGET',
        message: `Route "${r.name}" targets a paused agent — messages fall through to humans.`,
        routeIds: [r.id],
      })
    }
  }

  return conflicts
}

/**
 * True when every key in `subset` exists in `superset` with an
 * equal value. Used to detect shadowing: if the narrower rule's
 * conditions are a subset of the broader rule's, the broader
 * (higher-priority) rule swallows it.
 */
function isSubset(
  subset: AiAgentRoute['conditions'],
  superset: AiAgentRoute['conditions'],
): boolean {
  const keys = Object.keys(subset) as Array<keyof typeof subset>
  if (keys.length === 0) return false // an empty subset matches everything; not "more specific"
  return keys.every((k) => {
    const sv = subset[k]
    const bv = superset[k]
    if (bv === undefined) return false
    return JSON.stringify(sv) === JSON.stringify(bv)
  })
}
