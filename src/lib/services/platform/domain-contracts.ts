import type { PlatformToolManifest } from '@/lib/ai/tools/platform/contracts'
import { validateToolManifest } from '@/lib/ai/tools/platform/contracts'
import type { MessageTemplateDefinition } from '@/lib/messaging/types'
import type { BusinessEventManifest } from './business-event-contracts'
import { validateBusinessEventManifest } from './business-event-contracts'
import type { ChangeActionManifest } from './change-action-contracts'
import { validateChangeActionManifest } from './change-action-contracts'
import type { ChangeExecutorRegistration } from './change-executor-registry'

export interface BusinessDomainManifest {
  key: string
  version: number
  title: string
  description: string
  capabilities: readonly string[]
  tools: readonly PlatformToolManifest[]
  changeActions: readonly ChangeActionManifest[]
  events: readonly BusinessEventManifest[]
  messageTemplates: readonly MessageTemplateDefinition[]
}

export interface DomainRuntimeBinding<THandler> {
  key: string
  version: number
  handler: THandler
}

/**
 * Runtime bindings intentionally stay generic. AI tool executor registrations,
 * deterministic change executors and future event projectors have different
 * call signatures, while the business domain remains their owner.
 */
export interface BusinessDomainRuntime<
  TToolExecutorRegistration = never,
  TEventProjectorRegistration = never,
> {
  key: string
  version: number
  toolExecutors: readonly TToolExecutorRegistration[]
  changeExecutors: readonly ChangeExecutorRegistration[]
  eventProjectors: readonly TEventProjectorRegistration[]
}

export interface BusinessDomainContractIssue {
  code: string
  message: string
}

const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const CAPABILITY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

function duplicateIds(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

export function validateBusinessDomainManifest(
  domain: BusinessDomainManifest,
): BusinessDomainContractIssue[] {
  const issues: BusinessDomainContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!DOMAIN_RE.test(domain.key)) add('INVALID_DOMAIN_KEY', 'Domain key must be a stable lowercase identifier.')
  if (!Number.isInteger(domain.version) || domain.version < 1) {
    add('INVALID_DOMAIN_VERSION', 'Domain version must be a positive integer.')
  }
  if (!domain.title.trim() || !domain.description.trim()) {
    add('MISSING_DOMAIN_DESCRIPTION', 'title and description are required.')
  }

  const duplicateCapabilities = duplicateIds(domain.capabilities)
  if (duplicateCapabilities.length) {
    add('DUPLICATE_CAPABILITY', 'Duplicate capabilities: ' + duplicateCapabilities.join(', '))
  }
  for (const capability of domain.capabilities) {
    if (!CAPABILITY_RE.test(capability)) add('INVALID_CAPABILITY', 'Invalid capability: ' + capability)
  }
  const capabilitySet = new Set(domain.capabilities)

  const toolIds = domain.tools.map((tool) => tool.key + '@' + tool.version)
  for (const id of duplicateIds(toolIds)) add('DUPLICATE_TOOL', 'Duplicate tool contract: ' + id)
  for (const tool of domain.tools) {
    if (tool.domain !== domain.key) {
      add('TOOL_DOMAIN_MISMATCH', 'Tool ' + tool.key + ' belongs to ' + tool.domain + ', not ' + domain.key)
    }
    for (const issue of validateToolManifest(tool)) {
      add('TOOL_' + issue.code, tool.key + ': ' + issue.message)
    }
    for (const capability of tool.requiredCapabilities) {
      if (!capabilitySet.has(capability)) {
        add('TOOL_CAPABILITY_UNDECLARED', tool.key + ' requires undeclared capability ' + capability)
      }
    }
  }

  const actionIds = domain.changeActions.map((action) => action.key + '@' + action.version)
  for (const id of duplicateIds(actionIds)) add('DUPLICATE_CHANGE_ACTION', 'Duplicate change action: ' + id)
  const selectorOwners = new Map<string, string>()
  for (const action of domain.changeActions) {
    if (action.domain !== domain.key) {
      add(
        'CHANGE_ACTION_DOMAIN_MISMATCH',
        'Change action ' + action.key + ' belongs to ' + action.domain + ', not ' + domain.key,
      )
    }
    for (const issue of validateChangeActionManifest(action)) {
      add('CHANGE_ACTION_' + issue.code, action.key + ': ' + issue.message)
    }
    for (const selector of action.legacySelectors) {
      const selectorId = [selector.targetType, selector.intent, selector.targetId].join(':')
      const existing = selectorOwners.get(selectorId)
      if (existing) {
        add(
          'AMBIGUOUS_LEGACY_SELECTOR',
          'Legacy selector ' + selectorId + ' is shared by ' + existing + ' and ' + action.key,
        )
      } else {
        selectorOwners.set(selectorId, action.key)
      }
    }
  }

  const eventIds = domain.events.map((event) => event.key + '@' + event.version)
  for (const id of duplicateIds(eventIds)) add('DUPLICATE_EVENT', 'Duplicate business event: ' + id)
  for (const event of domain.events) {
    if (event.domain !== domain.key) {
      add('EVENT_DOMAIN_MISMATCH', 'Business event ' + event.key + ' belongs to ' + event.domain + ', not ' + domain.key)
    }
    for (const issue of validateBusinessEventManifest(event)) {
      add('EVENT_' + issue.code, event.key + ': ' + issue.message)
    }
  }

  const templateIds = domain.messageTemplates.map(
    (template) =>
      [template.key, template.audience, template.channel, template.locale.toLowerCase()].join('|'),
  )
  for (const id of duplicateIds(templateIds)) {
    add('DUPLICATE_MESSAGE_TEMPLATE', 'Duplicate message template: ' + id)
  }
  for (const template of domain.messageTemplates) {
    if (!template.key.trim() || !template.locale.trim() || !template.body.trim()) {
      add('INVALID_MESSAGE_TEMPLATE', 'Template key, locale, and body are required.')
    }
  }

  return issues
}

export function assertValidBusinessDomainManifest<T extends BusinessDomainManifest>(domain: T): T {
  const issues = validateBusinessDomainManifest(domain)
  if (issues.length) {
    throw new Error(
      'Invalid business domain ' +
        domain.key +
        '@' +
        domain.version +
        ': ' +
        issues.map((issue) => issue.code + ': ' + issue.message).join('; '),
    )
  }
  return domain
}

export function defineBusinessDomain<T extends BusinessDomainManifest>(domain: T): T {
  return assertValidBusinessDomainManifest(domain)
}

export function defineBusinessDomainRuntime<
  TToolExecutorRegistration = never,
  TEventProjectorRegistration = never,
>(
  runtime: BusinessDomainRuntime<TToolExecutorRegistration, TEventProjectorRegistration>,
): BusinessDomainRuntime<TToolExecutorRegistration, TEventProjectorRegistration> {
  if (!DOMAIN_RE.test(runtime.key)) throw new Error('Invalid runtime domain key: ' + runtime.key)
  if (!Number.isInteger(runtime.version) || runtime.version < 1) {
    throw new Error('Invalid runtime domain version: ' + runtime.key)
  }
  return runtime
}
