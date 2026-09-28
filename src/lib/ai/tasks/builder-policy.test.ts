import { describe, expect, it } from 'vitest'
import {
  BUILDER_APPROVAL_MODES,
  BUILDER_OPERATIONAL_MODES,
  BUILDER_TARGET_SCOPE_KINDS,
  validateBuilderOutreachPolicy,
  validateBuilderPublishPolicy,
} from './builder-policy'

describe('Agent Builder V2 policy', () => {
  it('keeps the documented fixed Builder choices', () => {
    expect(BUILDER_OPERATIONAL_MODES).toEqual(['reactive', 'outbound', 'both'])
    expect(BUILDER_APPROVAL_MODES).toEqual(['none', 'task', 'batch'])
    expect(BUILDER_TARGET_SCOPE_KINDS).toContain('domain_selector')
    expect(BUILDER_TARGET_SCOPE_KINDS).not.toContain('sql')
  })

  it('accepts a reactive revision without outbound Task Types', () => {
    expect(
      validateBuilderPublishPolicy({
        operationalMode: 'reactive',
        outreachPolicy: {},
      }),
    ).toBeNull()
  })

  it('blocks outbound publishing when no registered Task Type is selected', () => {
    expect(
      validateBuilderPublishPolicy({
        operationalMode: 'outbound',
        outreachPolicy: {},
      }),
    ).toBe('Outbound agents require at least one registered Task Type')
  })

  it('rejects arbitrary Task Type keys instead of accepting prompt-defined work', () => {
    expect(
      validateBuilderOutreachPolicy({
        taskTypes: [{ key: 'arbitrary.prompt.task', version: 1 }],
      }),
    ).toContain('is not registered')
  })

  it('rejects raw SQL as a target scope', () => {
    expect(
      validateBuilderOutreachPolicy({
        targetScope: { kind: 'sql', selector: 'select * from contacts' },
      }),
    ).toBe('Target scope must use a registered Builder scope kind')
  })

  it('rejects unknown approval modes', () => {
    expect(validateBuilderOutreachPolicy({ approvalMode: 'prompt' })).toBe(
      'Invalid approval mode',
    )
  })

  it('rejects unsafe or malformed outbound limits', () => {
    expect(
      validateBuilderOutreachPolicy({ limits: { maxTargets: 0 } }),
    ).toBe('limits.maxTargets must be a positive integer')
    expect(
      validateBuilderOutreachPolicy({ limits: { maxAttempts: '3' } }),
    ).toBe('limits.maxAttempts must be a positive integer')
    expect(
      validateBuilderOutreachPolicy({ limits: { dailyBudget: Infinity } }),
    ).toBe('limits.dailyBudget must be a non-negative finite number')
    expect(
      validateBuilderOutreachPolicy({ limits: { workingHours: '9-5' } }),
    ).toBe('limits.workingHours must use HH:MM-HH:MM')
  })

  it('rejects ungoverned extra limit keys', () => {
    expect(
      validateBuilderOutreachPolicy({ limits: { sendEverything: true } }),
    ).toBe('Unknown outbound limit: sendEverything')
  })

  it('validates target-scope parameter shape', () => {
    expect(
      validateBuilderOutreachPolicy({
        targetScope: { kind: 'tags', values: ['', 'vip'] },
      }),
    ).toBe('Target scope values must be non-empty strings')
  })
})
