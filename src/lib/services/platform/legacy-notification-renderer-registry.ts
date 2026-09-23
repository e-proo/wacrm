export interface LegacyCustomerNotificationDescriptor {
  id: string
  eventType: string
  intentId: string | null
  changeRequestId: string | null
}

export interface LegacyCustomerNotificationRenderInput {
  accountId: string
  notification: LegacyCustomerNotificationDescriptor
}

export interface LegacyCustomerNotificationRendererRegistration {
  key: string
  render: (
    input: LegacyCustomerNotificationRenderInput,
  ) => Promise<string | null>
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
    const rendered = await Promise.all(
      this.registrations.map((entry) => entry.render(input)),
    )
    const matches = rendered.filter(
      (value): value is string => value !== null,
    )
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new Error(
        'Ambiguous legacy notification renderer for notification ' +
          input.notification.id,
      )
    }
    return matches[0]
  }

  listKeys(): readonly string[] {
    return this.registrations.map((entry) => entry.key)
  }
}
