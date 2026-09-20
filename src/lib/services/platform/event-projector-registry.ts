import type {
  MessageAudience,
  MessageChannel,
  MessageContext,
} from '@/lib/messaging/types'

export interface BusinessEventProjectionInput {
  accountId: string
  eventType: string
  eventVersion: number
  subjectType: string
  subjectId: string
  audience: MessageAudience | null
  channel: MessageChannel | null
  correlationId: string | null
  causationId: string | null
  payload: Record<string, unknown>
}

export interface MessageTemplatePolicy {
  forbidSecrets?: boolean
  requiredBodyPlaceholders?: readonly string[]
}

export interface BusinessEventMessageProjection {
  eventKey: string
  audience: MessageAudience
  channel: MessageChannel
  locale: string
  context: MessageContext
  templatePolicy?: MessageTemplatePolicy
  emergencyText?: string
}

export type EventProjector = (
  input: BusinessEventProjectionInput,
) => Promise<BusinessEventMessageProjection>

export interface EventProjectorRegistration {
  eventType: string
  eventVersion: number
  projector: EventProjector
}

export class EventProjectorRegistry {
  private readonly projectors = new Map<string, EventProjectorRegistration>()

  register(registration: EventProjectorRegistration): this {
    if (!registration.eventType.trim()) {
      throw new Error('Event projector type is required.')
    }
    if (!Number.isInteger(registration.eventVersion) || registration.eventVersion < 1) {
      throw new Error('Event projector version must be a positive integer.')
    }

    const id = registration.eventType + '@' + registration.eventVersion
    if (this.projectors.has(id)) {
      throw new Error('Duplicate event projector: ' + id)
    }

    this.projectors.set(id, Object.freeze({ ...registration }))
    return this
  }

  has(eventType: string, eventVersion: number): boolean {
    return this.projectors.has(eventType + '@' + eventVersion)
  }

  get(eventType: string, eventVersion: number): EventProjectorRegistration | null {
    return this.projectors.get(eventType + '@' + eventVersion) ?? null
  }

  list(): readonly EventProjectorRegistration[] {
    return [...this.projectors.values()]
  }

  async project(input: BusinessEventProjectionInput): Promise<BusinessEventMessageProjection> {
    const registration = this.get(input.eventType, input.eventVersion)
    if (!registration) {
      throw new Error(
        'EVENT_PROJECTOR_NOT_REGISTERED:' + input.eventType + '@' + input.eventVersion,
      )
    }

    const projection = await registration.projector(input)
    if (projection.eventKey !== input.eventType) {
      throw new Error(
        'EVENT_PROJECTOR_KEY_MISMATCH:' + input.eventType + ':' + projection.eventKey,
      )
    }
    if (input.audience && projection.audience !== input.audience) {
      throw new Error(
        'EVENT_PROJECTOR_AUDIENCE_MISMATCH:' +
          input.eventType +
          ':' +
          input.audience +
          ':' +
          projection.audience,
      )
    }
    if (input.channel && projection.channel !== input.channel) {
      throw new Error(
        'EVENT_PROJECTOR_CHANNEL_MISMATCH:' +
          input.eventType +
          ':' +
          input.channel +
          ':' +
          projection.channel,
      )
    }

    return projection
  }
}
