// ============================================================
// Multi-agent domain types (Phase 1).
//
// Server-side type aliases derived from the SQL schema in
// migrations 045 / 046. Kept narrow + branded so a misspelled
// status string won't silently pass through to a DB filter.
// ============================================================

// --- shared primitives ---------------------------------------------------

export type AccountId = string
export type Uuid = string

export type AgentPurpose = 'customer_support' | 'admin_operations' | 'custom'

export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived'

export type RevisionStatus = 'draft' | 'published' | 'superseded' | 'rejected'

export type RouteKind = 'admin' | 'rule' | 'default'

export type Channel = 'whatsapp'

export type ConversationAiMode =
  | 'auto'
  | 'human_only'
  | 'ai_paused'
  | 'handoff'

export type RunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type RunPlane = 'admin' | 'customer'

export type TrustedIdentityStatus =
  | 'pending_verification'
  | 'active'
  | 'revoked'

export type ToolGrantPermission = 'read' | 'propose' | 'execute'

/** Allowlist of system-agent keys. Phase 1 seeds two. */
export const SYSTEM_AGENT_KEYS = [
  'customer_service',
  'admin_operations',
] as const
export type SystemAgentKey = (typeof SYSTEM_AGENT_KEYS)[number]

/** Bounded response-style enum surfaced in the UI. */
export type ResponseStyle = 'concise' | 'balanced' | 'detailed'

// --- entities ------------------------------------------------------------

export interface AiAgent {
  id: Uuid
  accountId: AccountId
  systemKey: SystemAgentKey | null
  slug: string
  name: string
  description: string | null
  purpose: AgentPurpose
  status: AgentStatus
  publishedRevisionId: Uuid | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface AiAgentRevision {
  id: Uuid
  accountId: AccountId
  agentId: Uuid
  revisionNumber: number
  status: RevisionStatus
  providerConnectionId: Uuid
  model: string
  systemPrompt: string | null
  responseStyle: ResponseStyle
  languagePolicy: string
  temperature: number | null
  maxOutputTokens: number | null
  maxToolRounds: number
  maxAiRepliesPerConversation: number
  handoffHumanMemberId: Uuid | null
  settings: Record<string, unknown>
  createdAt: string
  publishedAt: string | null
  publishedBy: Uuid | null
  rejectionReason: string | null
}

export interface TrustedAdminIdentity {
  id: Uuid
  accountId: AccountId
  channel: Channel
  normalizedAddress: string
  displayName: string | null
  memberId: Uuid | null
  status: TrustedIdentityStatus
  verificationMethod: 'otp' | 'in_app' | null
  // We never expose the code hash or its expiry; only the *need* to
  // verify is surfaced.
  verifiedAt: string | null
  revokedAt: string | null
  allowedCapabilities: ReadonlyArray<string>
  createdAt: string
}

export interface AiAgentRoute {
  id: Uuid
  accountId: AccountId
  agentId: Uuid
  name: string
  channel: Channel
  routeKind: RouteKind
  priority: number
  isActive: boolean
  conditions: RouteConditions
  stopProcessing: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Closed schema for route `conditions`. Validated by the route
 * authoring layer; never trusted from a raw client payload.
 */
export interface RouteConditions {
  inbox_id?: string
  tags?: string[]
  language?: string
  business_hours?: {
    start: string
    end: string
    tz: string
    weekdays: number[]
  }
}

export interface ConversationAiState {
  conversationId: Uuid
  accountId: AccountId
  assignedAiAgentId: Uuid | null
  mode: ConversationAiMode
  pauseUntil: string | null
  reason: string | null
  version: number
  updatedAt: string
}

export interface AiAgentRun {
  id: Uuid
  accountId: AccountId
  conversationId: Uuid
  inboundMessageId: Uuid
  aiAgentId: Uuid
  agentRevisionId: Uuid
  providerConnectionId: Uuid
  routeId: Uuid | null
  routeReason: string | null
  plane: RunPlane
  status: RunStatus
  attemptCount: number
  availableAt: string
  leaseExpiresAt: string | null
  claimedBy: string | null
  idempotencyKey: string
  outboundMessageId: Uuid | null
  inputTokens: number | null
  outputTokens: number | null
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
  createdAt: string
}

export interface AiAgentRunEvent {
  id: number
  accountId: AccountId
  runId: Uuid
  eventType: string
  payload: Record<string, unknown>
  actorType: 'service' | 'system' | 'user'
  actorId: string | null
  createdAt: string
}

// --- routing decision ---------------------------------------------------

/**
 * The pure output of `routeInboundMessage`. The runtime turns a
 * `route` decision into an `ai_agent_runs` row + a worker
 * dispatch; a `skip` decision is the documented no-op path.
 */
export type RoutingDecision =
  | {
      action: 'route'
      plane: RunPlane
      agentId: Uuid
      revisionId: Uuid
      providerConnectionId: Uuid
      reason: string
      routeId: Uuid | null
    }
  | { action: 'skip'; reason: string }

export interface RoutingContext {
  accountId: AccountId
  channel: Channel
  /** Normalized sender address (E.164 canonical). */
  senderAddress: string
  /** Pre-loaded conversation AI state, or null when none exists. */
  conversationAiState: ConversationAiState | null
  /** Whether a human teammate is currently assigned. */
  hasHumanAssignee: boolean
  /** Account-level features / flags. */
  multiAgentEnabled: boolean
  /** Concrete WhatsApp connection/inbox id that received the message. */
  inboxId?: string | null
  /** Normalized contact tag NAMES (the route editor stores free text). */
  tags?: ReadonlyArray<string>
  /** Conservative runtime language signal; null means unknown. */
  language?: string | null
}

export interface RoutingSnapshot {
  /** Active admin-plane identities for the account. */
  trustedIdentities: ReadonlyArray<TrustedAdminIdentity>
  /** Active routes ordered as the router will see them. */
  routes: ReadonlyArray<AiAgentRoute>
  /** Active agents + their published revision, joined. */
  agents: ReadonlyArray<{
    agent: AiAgent
    revision: AiAgentRevision | null
  }>
}
