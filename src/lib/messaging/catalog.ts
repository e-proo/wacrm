const EVENT_KEY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const GENERIC_STATES = new Set(['pending', 'approved', 'rejected', 'completed', 'failed'])

export function assertMessageEventKey(eventKey: string): void {
  if (!EVENT_KEY_RE.test(eventKey)) {
    throw new Error(`INVALID_MESSAGE_EVENT_KEY:${eventKey}`)
  }
}

/**
 * Exact domain templates always win. Common lifecycle events can fall back to
 * a generic service-request template so a newly-added service remains usable
 * before it receives bespoke copy.
 */
export function buildMessageEventFallbackChain(eventKey: string): string[] {
  assertMessageEventKey(eventKey)
  const chain = [eventKey]
  const state = eventKey.split('.').at(-1)
  if (state && GENERIC_STATES.has(state)) {
    const generic = `service_request.${state}`
    if (generic !== eventKey) chain.push(generic)
  }
  return chain
}

export function buildLocaleFallbackChain(locale: string): string[] {
  const normalized = locale.trim()
  if (!normalized) return ['ar']
  const chain = [normalized]
  const base = normalized.split('-')[0]
  if (base && base !== normalized) chain.push(base)
  if (!chain.includes('ar')) chain.push('ar')
  return chain
}
