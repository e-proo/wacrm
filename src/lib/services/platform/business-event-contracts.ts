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

export interface BusinessEventSubject {
  type: string
  id: string
}

export interface BusinessEventActor {
  type: string
  id: string
}

export interface BusinessEventEnvelope<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  event_id: string
  type: string
  version: number
  occurred_at: string
  account_id: string
  subject: BusinessEventSubject
  actor: BusinessEventActor | null
  correlation_id: string | null
  causation_id: string | null
  data: TData
}

export interface BusinessEventContractIssue {
  code: string
  message: string
}

const EVENT_KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const SUBJECT_RE = /^[a-z][a-z0-9_]*$/
const ACTOR_RE = /^[a-z][a-z0-9_]*$/

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

export function validateBusinessEventEnvelope(
  envelope: BusinessEventEnvelope,
  manifest: BusinessEventManifest,
): BusinessEventContractIssue[] {
  const issues: BusinessEventContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!envelope.event_id.trim()) add('EVENT_ID_REQUIRED', 'event_id is required.')
  if (envelope.type !== manifest.key) {
    add('EVENT_TYPE_MISMATCH', 'Envelope type does not match the manifest key.')
  }
  if (envelope.version !== manifest.version) {
    add('EVENT_VERSION_MISMATCH', 'Envelope version does not match the manifest version.')
  }
  if (!envelope.account_id.trim()) add('ACCOUNT_ID_REQUIRED', 'account_id is required.')
  if (!envelope.subject.id.trim()) add('SUBJECT_ID_REQUIRED', 'subject.id is required.')
  if (!manifest.subjectTypes.includes(envelope.subject.type)) {
    add('SUBJECT_TYPE_MISMATCH', 'Envelope subject type is not allowed by the manifest.')
  }
  if (!Number.isFinite(Date.parse(envelope.occurred_at))) {
    add('INVALID_OCCURRED_AT', 'occurred_at must be an ISO-compatible timestamp.')
  }
  if (envelope.actor) {
    if (!ACTOR_RE.test(envelope.actor.type)) {
      add('INVALID_ACTOR_TYPE', 'actor.type must be a stable lowercase identifier.')
    }
    if (!envelope.actor.id.trim()) add('ACTOR_ID_REQUIRED', 'actor.id is required when actor exists.')
  }
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    add('INVALID_EVENT_DATA', 'data must be an object.')
  }

  return issues
}

export function assertValidBusinessEventEnvelope<TData extends Record<string, unknown>>(
  envelope: BusinessEventEnvelope<TData>,
  manifest: BusinessEventManifest,
): BusinessEventEnvelope<TData> {
  const issues = validateBusinessEventEnvelope(envelope, manifest)
  if (issues.length) {
    throw new Error(
      'Invalid business event envelope ' +
        envelope.type +
        '@' +
        envelope.version +
        ': ' +
        issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
    )
  }
  return envelope
}
