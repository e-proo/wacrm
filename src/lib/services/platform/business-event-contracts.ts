export type BusinessEventSnapshotPolicy =
  | 'immutable_subject_reference'
  | 'embedded_event_snapshot'

export interface BusinessEventManifest {
  key: string
  version: number
  domain: string
  title: string
  description: string
  subjectTypes: readonly string[]
  snapshotPolicy: BusinessEventSnapshotPolicy
}

export interface BusinessEventContractIssue {
  code: string
  message: string
}

const EVENT_KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const SUBJECT_RE = /^[a-z][a-z0-9_]*$/

export function validateBusinessEventManifest(
  event: BusinessEventManifest,
): BusinessEventContractIssue[] {
  const issues: BusinessEventContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!EVENT_KEY_RE.test(event.key)) add('INVALID_KEY', 'Business event key must be namespaced.')
  if (!DOMAIN_RE.test(event.domain)) add('INVALID_DOMAIN', 'Domain must be a stable lowercase identifier.')
  if (!Number.isInteger(event.version) || event.version < 1) {
    add('INVALID_VERSION', 'Business event version must be a positive integer.')
  }
  if (!event.title.trim() || !event.description.trim()) {
    add('MISSING_DESCRIPTION', 'title and description are required.')
  }
  if (event.subjectTypes.length === 0) {
    add('SUBJECT_TYPE_REQUIRED', 'At least one subject type is required.')
  }
  if (new Set(event.subjectTypes).size !== event.subjectTypes.length) {
    add('DUPLICATE_SUBJECT_TYPE', 'subjectTypes contains duplicates.')
  }
  for (const subjectType of event.subjectTypes) {
    if (!SUBJECT_RE.test(subjectType)) {
      add('INVALID_SUBJECT_TYPE', 'Invalid subject type: ' + subjectType)
    }
  }

  return issues
}

export function assertValidBusinessEventManifest<T extends BusinessEventManifest>(event: T): T {
  const issues = validateBusinessEventManifest(event)
  if (issues.length) {
    throw new Error(
      'Invalid business event ' +
        event.key +
        '@' +
        event.version +
        ': ' +
        issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
    )
  }
  return event
}
