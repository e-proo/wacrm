import { describe, expect, it } from 'vitest'
import { getCurrentPlatformTool } from '@/lib/ai/tools/platform/current-domain-registry'
import { isStrictToolJsonSchema, toJsonSchema, validateToolArguments } from './tool-schema'

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

  it('supports a closed root object schema with no properties', () => {
    const empty = {
      inputSchema: { type: 'object', additionalProperties: false },
    }
    expect(toJsonSchema(empty as never)).toEqual({
      type: 'object',
      additionalProperties: false,
    })
    expect(validateToolArguments(empty as never, {})).toMatchObject({ ok: true })
    expect(validateToolArguments(empty as never, { injected: true })).toMatchObject({
      ok: false,
    })
  })
})

describe('provider strict-mode compatibility', () => {
  it('keeps fully required closed tool arguments strict', () => {
    const tool = getCurrentPlatformTool('services.get', 1)!
    expect(isStrictToolJsonSchema(toJsonSchema(tool))).toBe(true)
  })

  it('does not advertise optional real platform arguments as strict', () => {
    const tool = getCurrentPlatformTool('services.search', 1)!
    expect(isStrictToolJsonSchema(toJsonSchema(tool))).toBe(false)
    expect(validateToolArguments(tool, {})).toMatchObject({ ok: true })
    expect(validateToolArguments(tool, { unexpected: 'input' })).toMatchObject({ ok: false })
  })

  it('rejects generic nested objects and unbounded additional properties for strict mode', () => {
    expect(isStrictToolJsonSchema(toJsonSchema(getCurrentPlatformTool('services.match_request', 1)!))).toBe(false)
    expect(isStrictToolJsonSchema({
      type: 'object', properties: { flags: { type: 'object' } },
      required: ['flags'], additionalProperties: false,
    })).toBe(false)
  })

  it('accepts nested closed objects only when every nested key is required', () => {
    const schema = {
      type: 'object',
      properties: {
        filter: {
          type: 'object', properties: { query: { type: 'string' } },
          required: ['query'], additionalProperties: false,
        },
      },
      required: ['filter'], additionalProperties: false,
    }
    expect(isStrictToolJsonSchema(schema)).toBe(true)
    expect(isStrictToolJsonSchema({
      ...schema,
      properties: {
        filter: { ...schema.properties.filter, required: [] },
      },
    })).toBe(false)
  })

  it('does not claim strict compliance for unknown composed schemas', () => {
    expect(isStrictToolJsonSchema({
      type: 'object', properties: {
        filter: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['filter'], additionalProperties: false,
    })).toBe(false)
  })
})
