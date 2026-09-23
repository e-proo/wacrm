export interface LegacyCustomerNotificationDescriptor {
  id: string
  intentId: string | null
  fxTradeRequestId: string | null
  eventType: string
}

export interface LegacyCustomerNotificationRenderInput {
  accountId: string
  notification: LegacyCustomerNotificationDescriptor
}

export interface LegacyCustomerNotificationRendererRegistration {
  key: string
  matches: (notification: LegacyCustomerNotificationDescriptor) => boolean
  render: (input: LegacyCustomerNotificationRenderInput) => Promise<string>
}

/**
 * Temporary strangler registry for domain-specific renderers still required by
 * a controlled legacy rollback path. New domains must use Business Event
 * projectors instead of registering here.
 */
export class LegacyCustomerNotificationRendererRegistry {
  private readonly registrations: LegacyCustomerNotificationRendererRegistration[] = []

  register(
    registration: LegacyCustomerNotificationRendererRegistration,
  ): this {
    if (!registration.key.trim()) {
      throw new Error('Legacy notification renderer key is required.')
    }
    if (this.registrations.some((entry) => entry.key === registration.key)) {
      throw new Error('Duplicate legacy notification renderer: ' + registration.key)
    }
    this.registrations.push(registration)
    return this
  }

  async render(
    input: LegacyCustomerNotificationRenderInput,
  ): Promise<string | null> {
    const matches = this.registrations.filter((entry) =>
      entry.matches(input.notification),
    )
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new Error(
        'Ambiguous legacy notification renderer for notification ' +
          input.notification.id,
      )
    }
    return matches[0].render(input)
  }

  listKeys(): readonly string[] {
    return this.registrations.map((entry) => entry.key)
  }
}
