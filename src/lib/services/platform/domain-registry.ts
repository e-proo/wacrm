import type { PlatformToolManifest } from '@/lib/ai/tools/platform/contracts'
import {
  assertValidBusinessDomainManifest,
  type BusinessDomainManifest,
} from './domain-contracts'
import {
  legacyChangeSelectorId,
  matchesLegacyChangeSelector,
  type ChangeActionManifest,
} from './change-action-contracts'
import type { BusinessEventManifest } from './business-event-contracts'
import { EventRegistry } from './event-registry'

export class BusinessDomainRegistry {
  private readonly domains = new Map<string, BusinessDomainManifest>()
  private readonly tools = new Map<string, PlatformToolManifest>()
  private readonly changeActions = new Map<string, ChangeActionManifest>()
  private readonly legacySelectorOwners = new Map<string, string>()
  private readonly events = new EventRegistry()

  register(rawDomain: BusinessDomainManifest): this {
    const domain = assertValidBusinessDomainManifest(rawDomain)
    if (this.domains.has(domain.key)) throw new Error('Duplicate business domain: ' + domain.key)

    for (const tool of domain.tools) {
      const id = tool.key + '@' + tool.version
      if (this.tools.has(id)) throw new Error('Duplicate business-domain tool: ' + id)
    }
    for (const action of domain.changeActions) {
      const id = action.key + '@' + action.version
      if (this.changeActions.has(id)) throw new Error('Duplicate change action: ' + id)
      for (const selector of action.legacySelectors) {
        const selectorId = legacyChangeSelectorId(selector)
        const existing = this.legacySelectorOwners.get(selectorId)
        if (existing) {
          throw new Error(
            'Ambiguous legacy change selector ' + selectorId + ': ' + existing + ' and ' + id,
          )
        }
      }
    }
    for (const event of domain.events) {
      if (this.events.has(event.key, event.version)) {
        throw new Error('Duplicate business event: ' + event.key + '@' + event.version)
      }
    }

    const frozen: BusinessDomainManifest = Object.freeze({
      ...domain,
      capabilities: Object.freeze([...domain.capabilities]),
      tools: Object.freeze([...domain.tools]),
      changeActions: Object.freeze([...domain.changeActions]),
      events: Object.freeze([...domain.events]),
      messageTemplates: Object.freeze([...domain.messageTemplates]),
    })

    this.domains.set(domain.key, frozen)
    for (const tool of domain.tools) {
      this.tools.set(tool.key + '@' + tool.version, Object.freeze({ ...tool }))
    }
    for (const action of domain.changeActions) {
      const id = action.key + '@' + action.version
      this.changeActions.set(
        id,
        Object.freeze({
          ...action,
          legacySelectors: Object.freeze([...action.legacySelectors]),
        }),
      )
      for (const selector of action.legacySelectors) {
        this.legacySelectorOwners.set(legacyChangeSelectorId(selector), id)
      }
    }
    for (const event of domain.events) this.events.register(event)

    return this
  }

  getDomain(key: string): BusinessDomainManifest | null {
    return this.domains.get(key) ?? null
  }

  getTool(key: string, version: number): PlatformToolManifest | null {
    return this.tools.get(key + '@' + version) ?? null
  }

  getChangeAction(key: string, version: number): ChangeActionManifest | null {
    return this.changeActions.get(key + '@' + version) ?? null
  }

  getEvent(key: string, version: number): BusinessEventManifest | null {
    return this.events.get(key, version)
  }

  resolveLegacyChangeAction(input: {
    targetType: string
    targetId: string | null
    intent: string
  }): ChangeActionManifest | null {
    for (const action of this.changeActions.values()) {
      if (action.legacySelectors.some((selector) => matchesLegacyChangeSelector(selector, input))) {
        return action
      }
    }
    return null
  }

  listDomains(): readonly BusinessDomainManifest[] {
    return [...this.domains.values()]
  }

  listChangeActions(): readonly ChangeActionManifest[] {
    return [...this.changeActions.values()]
  }

  listEvents(): readonly BusinessEventManifest[] {
    return this.events.list()
  }
}
