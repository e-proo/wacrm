import { describe, expect, it } from 'vitest'
import {
  listBuilderToolDefinitions,
  listCurrentToolDefinitions,
} from './runtime-tool-compat'

describe('builder tool compatibility projection', () => {
  it('never exposes execute grants to the builder', () => {
    const builderTools = listBuilderToolDefinitions()

    expect(builderTools.length).toBeGreaterThan(0)
    expect(
      builderTools.every((tool) =>
        tool.grantPermissions.every(
          (permission) => permission === 'read' || permission === 'propose',
        ),
      ),
    ).toBe(true)
  })

  it('is a safe subset of the current registry projection', () => {
    const currentKeys = new Set(
      listCurrentToolDefinitions().map((tool) => `${tool.key}@${tool.version}`),
    )
    for (const tool of listBuilderToolDefinitions()) {
      expect(currentKeys.has(`${tool.key}@${tool.version}`)).toBe(true)
    }
  })
})
