import {
  assertValidBusinessEventManifest,
  type BusinessEventManifest,
} from './business-event-contracts'

export class EventRegistry {
  private readonly events = new Map<string, BusinessEventManifest>()

  register(event: BusinessEventManifest): this {
    const valid = assertValidBusinessEventManifest(event)
    const id = valid.key + '@' + valid.version
    if (this.events.has(id)) throw new Error('Duplicate business event: ' + id)
    this.events.set(
      id,
      Object.freeze({
        ...valid,
        subjectTypes: Object.freeze([...valid.subjectTypes]),
      }),
    )
    return this
  }

  has(key: string, version: number): boolean {
    return this.events.has(key + '@' + version)
  }

  get(key: string, version: number): BusinessEventManifest | null {
    return this.events.get(key + '@' + version) ?? null
  }

  list(): readonly BusinessEventManifest[] {
    return [...this.events.values()]
  }
}
