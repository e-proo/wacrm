export type ChangeTargetRequirement = 'present' | 'absent' | 'any'

export interface LegacyChangeSelector {
  targetType: string
  intent: string
  targetId: ChangeTargetRequirement
}

export interface ChangeActionManifest {
  key: string
  version: number
  domain: string
  title: string
  description: string
  approvalRequired: boolean
  idempotent: boolean
  legacySelectors: readonly LegacyChangeSelector[]
}

export interface ChangeActionContractIssue {
  code: string
  message: string
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const LEGACY_TOKEN_RE = /^[a-z][a-z0-9_]*$/

function selectorId(selector: LegacyChangeSelector): string {
  return [selector.targetType, selector.intent, selector.targetId].join(':')
}

export function validateChangeActionManifest(
  action: ChangeActionManifest,
): ChangeActionContractIssue[] {
  const issues: ChangeActionContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!KEY_RE.test(action.key)) add('INVALID_KEY', 'Change action key must be namespaced.')
  if (!DOMAIN_RE.test(action.domain)) add('INVALID_DOMAIN', 'Domain must be a stable lowercase identifier.')
  if (!action.key.startsWith(action.domain + '.')) {
    add('DOMAIN_KEY_MISMATCH', 'Change action key must start with its domain.')
  }
  if (!Number.isInteger(action.version) || action.version < 1) {
    add('INVALID_VERSION', 'Change action version must be a positive integer.')
  }
  if (!action.title.trim() || !action.description.trim()) {
    add('MISSING_DESCRIPTION', 'title and description are required.')
  }
  if (!action.approvalRequired) {
    add('APPROVAL_REQUIRED', 'Authoritative change actions must require explicit approval.')
  }
  if (!action.idempotent) {
    add('IDEMPOTENCY_REQUIRED', 'Authoritative change actions must be replay-safe.')
  }

  const seenSelectors = new Set<string>()
  for (const selector of action.legacySelectors) {
    if (!LEGACY_TOKEN_RE.test(selector.targetType)) {
      add('INVALID_LEGACY_TARGET_TYPE', 'Legacy targetType must be a stable lowercase identifier.')
    }
    if (!LEGACY_TOKEN_RE.test(selector.intent)) {
      add('INVALID_LEGACY_INTENT', 'Legacy intent must be a stable lowercase identifier.')
    }
    const id = selectorId(selector)
    if (seenSelectors.has(id)) add('DUPLICATE_LEGACY_SELECTOR', 'Duplicate legacy selector: ' + id)
    seenSelectors.add(id)
  }

  return issues
}

export function assertValidChangeActionManifest<T extends ChangeActionManifest>(action: T): T {
  const issues = validateChangeActionManifest(action)
  if (issues.length) {
    throw new Error(
      'Invalid change action ' +
        action.key +
        '@' +
        action.version +
        ': ' +
        issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
    )
  }
  return action
}

export function matchesLegacyChangeSelector(
  selector: LegacyChangeSelector,
  input: { targetType: string; targetId: string | null; intent: string },
): boolean {
  if (selector.targetType !== input.targetType || selector.intent !== input.intent) return false
  if (selector.targetId === 'present') return Boolean(input.targetId)
  if (selector.targetId === 'absent') return !input.targetId
  return true
}

export function legacyChangeSelectorId(selector: LegacyChangeSelector): string {
  return selectorId(selector)
}
