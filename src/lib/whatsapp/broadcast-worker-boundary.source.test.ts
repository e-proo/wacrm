import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('durable broadcast delivery boundary', () => {
  it('browser only enqueues; never sends batches from a tab', () => {
    const wizard = source('../../hooks/use-broadcast-sending.ts')
    expect(wizard).toContain('/api/whatsapp/broadcast/enqueue')
    expect(wizard).not.toContain("fetch('/api/whatsapp/broadcast'")
  })
  it('public API and resume route do not fan out with after()', () => {
    for (const file of [
      '../../app/api/v1/broadcasts/route.ts',
      '../../app/api/whatsapp/broadcast/[id]/resume/route.ts',
    ]) {
      const code = source(file)
      expect(code).toContain('enqueueBroadcastDelivery')
      expect(code).not.toContain('after(')
      expect(code).not.toContain('deliverBroadcast')
    }
  })
  it('retires the legacy request-bound send endpoint', () => {
    const legacy = source('../../app/api/whatsapp/broadcast/route.ts')
    expect(legacy).toContain('status: 410')
    expect(legacy).not.toContain('deliverBroadcast')
  })
  it('keeps worker secret gated and TEST-only', () => {
    const worker = source('../../app/api/internal/whatsapp-broadcast-worker/route.ts')
    expect(worker).toContain('isOpenWATestProject()')
    expect(worker).toContain('timingSafeEqual')
    expect(worker).toContain('processBroadcastDeliveryTick')
  })
  it('reserves provider-native identity before dispatch', () => {
    const core = source('./broadcast-core.ts')
    expect(core.indexOf("status: 'sending'")).toBeGreaterThan(-1)
    expect(core.indexOf('dispatch_reserved_at:')).toBeGreaterThan(-1)
    expect(core.indexOf('dispatch_reserved_at:')).toBeLessThan(core.indexOf('resolved.transport.send('))
  })
})
