import { describe, expect, it } from 'vitest'
import { getCurrentPlatformTool } from '@/lib/ai/tools/platform/current-domain-registry'
import { toJsonSchema, validateToolArguments } from './tool-schema'

describe('strict native tool schemas', () => {
  const tool = getCurrentPlatformTool('services.get', 1)!

  it('emits additionalProperties=false', () => {
    expect(toJsonSchema(tool)).toMatchObject({ additionalProperties: false })
  })

  it('rejects unknown provider arguments', () => {
    expect(validateToolArguments(tool, { id_or_code: 'SVC', injected: true })).toMatchObject({ ok: false })
  })

  it('accepts the closed valid shape', () => {
    expect(validateToolArguments(tool, { id_or_code: 'SVC' })).toMatchObject({ ok: true })
  })
})
