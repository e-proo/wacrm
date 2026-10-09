import { describe, expect, it } from 'vitest'
import { getRegisteredTool } from './tool-registry'
import { toJsonSchema, validateToolArguments } from './tool-schema'

describe('strict native tool schemas', () => {
  const tool = getRegisteredTool('services.get')!

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
