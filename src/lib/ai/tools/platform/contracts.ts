export type PlatformToolPlane = 'customer' | 'admin'
export type PlatformToolPermission = 'read' | 'propose' | 'execute'
export type PlatformToolRisk = 'read' | 'low' | 'medium' | 'high' | 'critical'
export type PlatformToolSideEffect = 'none' | 'proposal' | 'authoritative_write'
export type PlatformToolAuditPolicy = 'none' | 'invocation' | 'proposal_and_execution'

export interface PlatformToolErrorContract {
  code: string
  safeToShow: boolean
  meaning: string
}

export interface PlatformToolExample {
  situation: string
  input: Record<string, unknown>
  expectedBehavior: string
}

export interface PlatformToolManifest {
  key: string
  version: number
  domain: string
  title: string
  description: string
  purpose: string
  whenToUse: readonly string[]
  whenNotToUse: readonly string[]
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema: Readonly<Record<string, unknown>>
  permission: PlatformToolPermission
  risk: PlatformToolRisk
  allowedPlanes: readonly PlatformToolPlane[]
  requiredCapabilities: readonly string[]
  supportedGrantConstraints: readonly string[]
  sideEffect: PlatformToolSideEffect
  approvalRequired: boolean
  idempotent: boolean
  audit: PlatformToolAuditPolicy
  modelExposed: boolean
  serverOnly: boolean
  examples: readonly PlatformToolExample[]
  errorContract: readonly PlatformToolErrorContract[]
}

export interface ToolContractIssue {
  code: string
  message: string
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/

export function validateToolManifest(tool: PlatformToolManifest): ToolContractIssue[] {
  const issues: ToolContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!KEY_RE.test(tool.key)) add('INVALID_KEY', 'Tool key must be namespaced: domain.action.')
  if (!DOMAIN_RE.test(tool.domain)) add('INVALID_DOMAIN', 'Domain must be a stable lowercase identifier.')
  if (!tool.key.startsWith(`${tool.domain}.`)) add('DOMAIN_KEY_MISMATCH', 'Tool key must start with its domain.')
  if (!Number.isInteger(tool.version) || tool.version < 1) add('INVALID_VERSION', 'Tool version must be a positive integer.')
  if (!tool.title.trim() || !tool.description.trim() || !tool.purpose.trim()) {
    add('MISSING_DESCRIPTION', 'title, description, and purpose are required.')
  }
  if (tool.whenToUse.length === 0) add('WHEN_TO_USE_REQUIRED', 'At least one whenToUse rule is required.')
  if (tool.whenNotToUse.length === 0) add('WHEN_NOT_TO_USE_REQUIRED', 'At least one whenNotToUse rule is required.')
  if (tool.allowedPlanes.length === 0) add('PLANE_REQUIRED', 'At least one allowed plane is required.')
  if (new Set(tool.allowedPlanes).size !== tool.allowedPlanes.length) add('DUPLICATE_PLANE', 'allowedPlanes contains duplicates.')
  if (tool.errorContract.length === 0) add('ERROR_CONTRACT_REQUIRED', 'Every tool needs a bounded error contract.')

  if (tool.permission === 'read' && tool.sideEffect !== 'none') {
    add('READ_SIDE_EFFECT', 'A read tool cannot have side effects.')
  }
  if (tool.permission === 'propose' && tool.sideEffect !== 'proposal') {
    add('PROPOSE_EFFECT_MISMATCH', 'A propose tool must only create a proposal/change request.')
  }
  if (tool.permission === 'execute' && tool.sideEffect !== 'authoritative_write') {
    add('EXECUTE_EFFECT_MISMATCH', 'An execute tool is reserved for deterministic authoritative writes.')
  }

  // The core safety invariant: models never get deterministic write executors.
  if (tool.permission === 'execute' && (tool.modelExposed || !tool.serverOnly)) {
    add('MODEL_EXECUTE_FORBIDDEN', 'Execute tools must be serverOnly and never modelExposed.')
  }
  if (tool.sideEffect === 'authoritative_write' && tool.modelExposed) {
    add('MODEL_WRITE_FORBIDDEN', 'Authoritative write tools cannot be exposed to a model.')
  }
  if (tool.sideEffect === 'proposal' && !tool.idempotent) {
    add('PROPOSAL_IDEMPOTENCY_REQUIRED', 'Proposal tools must define replay-safe idempotency.')
  }
  if (tool.sideEffect !== 'none' && tool.audit === 'none') {
    add('MUTATION_AUDIT_REQUIRED', 'Proposal/write operations must be audited.')
  }
  if ((tool.risk === 'high' || tool.risk === 'critical') && tool.sideEffect === 'proposal' && !tool.approvalRequired) {
    add('HIGH_RISK_APPROVAL_REQUIRED', 'High/critical proposals require explicit approval.')
  }
  if (tool.allowedPlanes.includes('admin') && tool.modelExposed && tool.requiredCapabilities.length === 0) {
    add('ADMIN_CAPABILITY_REQUIRED', 'Admin-plane model tools require at least one trusted-admin capability.')
  }
  if (tool.allowedPlanes.includes('customer') && tool.permission === 'execute') {
    add('CUSTOMER_EXECUTE_FORBIDDEN', 'Customer plane cannot receive execute tools.')
  }

  const allowedConstraints = new Set(['channels', 'service_ids', 'currencies', 'regions', 'max_amount'])
  for (const key of tool.supportedGrantConstraints) {
    if (!allowedConstraints.has(key)) add('UNKNOWN_CONSTRAINT', `Unsupported grant constraint: ${key}`)
  }
  return issues
}

export function assertValidToolManifest<T extends PlatformToolManifest>(tool: T): T {
  const issues = validateToolManifest(tool)
  if (issues.length) {
    throw new Error(`Invalid tool manifest ${tool.key}@${tool.version}: ${issues.map((i) => `${i.code}: ${i.message}`).join('; ')}`)
  }
  return tool
}

export function renderToolUsageDescription(tool: PlatformToolManifest): string {
  const use = tool.whenToUse.map((x) => `Use when: ${x}`).join(' ')
  const avoid = tool.whenNotToUse.map((x) => `Do not use when: ${x}`).join(' ')
  const approval = tool.approvalRequired ? 'Requires human approval before execution.' : ''
  return [tool.description, use, avoid, approval].filter(Boolean).join(' ')
}
