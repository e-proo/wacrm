import {
  assertValidBusinessEventEnvelope,
  assertValidBusinessEventManifest,
  type BusinessEventActor,
  type BusinessEventEnvelope,
  type BusinessEventManifest,
} from '@/lib/services/platform/business-event-contracts'

export type CoverageBusinessEventType =
  | 'coverage.offer.approved'
  | 'coverage.offer.activated'
  | 'coverage.offer.cancelled'
  | 'coverage.offer.fulfilled'
  | 'coverage.offer.expired'
  | 'coverage.request.approved'
  | 'coverage.request.activated'
  | 'coverage.request.cancelled'
  | 'coverage.request.fulfilled'
  | 'coverage.request.expired'
  | 'coverage.match.reserved'
  | 'coverage.match.released'

interface CoverageEventDefinition {
  key: CoverageBusinessEventType
  title: string
  description: string
  subjectType: 'coverage_offer' | 'coverage_request' | 'coverage_match'
}

const DEFINITIONS: readonly CoverageEventDefinition[] = [
  {
    key: 'coverage.offer.approved',
    title: 'Coverage offer approved',
    description:
      'An approved coverage proposal created an authoritative active coverage offer.',
    subjectType: 'coverage_offer',
  },
  {
    key: 'coverage.offer.activated',
    title: 'Coverage offer activated',
    description: 'A draft coverage offer became active and available for matching.',
    subjectType: 'coverage_offer',
  },
  {
    key: 'coverage.offer.cancelled',
    title: 'Coverage offer cancelled',
    description: 'A coverage offer was cancelled and is no longer available for matching.',
    subjectType: 'coverage_offer',
  },
  {
    key: 'coverage.offer.fulfilled',
    title: 'Coverage offer fulfilled',
    description: 'A coverage offer completed its business lifecycle as fulfilled.',
    subjectType: 'coverage_offer',
  },
  {
    key: 'coverage.offer.expired',
    title: 'Coverage offer expired',
    description: 'A coverage offer expired and is no longer available for matching.',
    subjectType: 'coverage_offer',
  },
  {
    key: 'coverage.request.approved',
    title: 'Coverage request approved',
    description:
      'An approved coverage proposal created an authoritative active coverage request.',
    subjectType: 'coverage_request',
  },
  {
    key: 'coverage.request.activated',
    title: 'Coverage request activated',
    description: 'A draft coverage request became active and available for matching.',
    subjectType: 'coverage_request',
  },
  {
    key: 'coverage.request.cancelled',
    title: 'Coverage request cancelled',
    description: 'A coverage request was cancelled and is no longer available for matching.',
    subjectType: 'coverage_request',
  },
  {
    key: 'coverage.request.fulfilled',
    title: 'Coverage request fulfilled',
    description: 'A coverage request completed its business lifecycle as fulfilled.',
    subjectType: 'coverage_request',
  },
  {
    key: 'coverage.request.expired',
    title: 'Coverage request expired',
    description: 'A coverage request expired and is no longer available for matching.',
    subjectType: 'coverage_request',
  },
  {
    key: 'coverage.match.reserved',
    title: 'Coverage match reserved',
    description:
      'Coverage capacity was atomically reserved between an offer and a request.',
    subjectType: 'coverage_match',
  },
  {
    key: 'coverage.match.released',
    title: 'Coverage match released',
    description:
      'A previously reserved coverage match released its reserved capacity.',
    subjectType: 'coverage_match',
  },
]

export const COVERAGE_BUSINESS_EVENT_MANIFESTS: readonly BusinessEventManifest[] =
  DEFINITIONS.map((definition) =>
    assertValidBusinessEventManifest({
      key: definition.key,
      version: 1,
      domain: 'coverage',
      title: definition.title,
      description: definition.description,
      subjectTypes: [definition.subjectType],
      snapshotPolicy: 'embedded_event_snapshot',
    }),
  )

const MANIFEST_BY_KEY = new Map(
  COVERAGE_BUSINESS_EVENT_MANIFESTS.map((manifest) => [manifest.key, manifest]),
)

const SUBJECT_BY_KEY = new Map(
  DEFINITIONS.map((definition) => [definition.key, definition.subjectType]),
)

export function getCoverageBusinessEventManifest(
  key: CoverageBusinessEventType,
): BusinessEventManifest {
  const manifest = MANIFEST_BY_KEY.get(key)
  if (!manifest) throw new Error('Unknown Coverage business event: ' + key)
  return manifest
}

export function buildCoverageBusinessEvent<TData extends Record<string, unknown>>(input: {
  eventId: string
  type: CoverageBusinessEventType
  occurredAt: string
  accountId: string
  subjectId: string
  actor?: BusinessEventActor | null
  correlationId?: string | null
  causationId?: string | null
  data: TData
}): BusinessEventEnvelope<TData> {
  const manifest = getCoverageBusinessEventManifest(input.type)
  const subjectType = SUBJECT_BY_KEY.get(input.type)
  if (!subjectType) throw new Error('Coverage event subject type is not registered: ' + input.type)

  return assertValidBusinessEventEnvelope(
    {
      event_id: input.eventId,
      type: input.type,
      version: manifest.version,
      occurred_at: input.occurredAt,
      account_id: input.accountId,
      subject: {
        type: subjectType,
        id: input.subjectId,
      },
      actor: input.actor ?? null,
      correlation_id: input.correlationId ?? null,
      causation_id: input.causationId ?? null,
      data: input.data,
    },
    manifest,
  )
}
