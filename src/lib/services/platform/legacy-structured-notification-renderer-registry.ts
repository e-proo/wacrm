export interface LegacyStructuredNotificationRenderInput {
  accountId: string
  eventKey: string
  payload: Record<string, unknown>
}

export interface LegacyStructuredNotificationRendererRegistration {
  key: string
  render: (
    input: LegacyStructuredNotificationRenderInput,
  ) => Promise<string | null>
}

/**
 * Temporary strangler registry for structured notifications that still need
 * the historical customer notification outbox. New domain delivery should use
 * canonical Business Events and Event Projectors.
 */
export class LegacyStructuredNotificationRendererRegistry {
  private readonly registrations: LegacyStructuredNotificationRendererRegistration[] = []

  register(
    registration: LegacyStructuredNotificationRendererRegistration,
  ): this {
    if (!registration.key.trim()) {
      throw new Error('Legacy structured notification renderer key is required.')
    }
    if (this.registrations.some((entry) => entry.key === registration.key)) {
      throw new Error(
        'Duplicate legacy structured notification renderer: ' + registration.key,
      )
    }
    this.registrations.push(registration)
    return this
  }

  async render(
    input: LegacyStructuredNotificationRenderInput,
  ): Promise<string | null> {
    const rendered = await Promise.all(
      this.registrations.map((entry) => entry.render(input)),
    )
    const matches = rendered.filter(
      (value): value is string => value !== null,
    )
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new Error(
        'Ambiguous legacy structured notification renderer: ' + input.eventKey,
      )
    }
    return matches[0]
  }
}
