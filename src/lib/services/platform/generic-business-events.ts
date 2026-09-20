import {
  assertValidBusinessEventManifest,
  type BusinessEventManifest,
} from './business-event-contracts'

export type GenericServiceRequestEventType =
  | 'service_request.approved'
  | 'service_request.rejected'
  | 'service_request.matched'
  | 'service_request.needs_clarification'
  | 'service_request.completed'

const DEFINITIONS: readonly {
  key: GenericServiceRequestEventType
  title: string
  description: string
}[] = [
  {
    key: 'service_request.approved',
    title: 'Service request approved',
    description: 'A generic customer service request was approved.',
  },
  {
    key: 'service_request.rejected',
    title: 'Service request rejected',
    description: 'A generic customer service request was rejected.',
  },
  {
    key: 'service_request.matched',
    title: 'Service request matched',
    description: 'A generic customer service request was matched to an available service.',
  },
  {
    key: 'service_request.needs_clarification',
    title: 'Service request needs clarification',
    description: 'A generic customer service request requires more customer information.',
  },
  {
    key: 'service_request.completed',
    title: 'Service request completed',
    description: 'A generic customer service request completed its lifecycle.',
  },
]

export const PLATFORM_GENERIC_BUSINESS_EVENT_MANIFESTS: readonly BusinessEventManifest[] =
  DEFINITIONS.map((definition) =>
    assertValidBusinessEventManifest({
      key: definition.key,
      version: 1,
      domain: 'platform',
      title: definition.title,
      description: definition.description,
      subjectTypes: ['service_intent'],
      snapshotPolicy: 'embedded_event_snapshot',
    }),
  )
