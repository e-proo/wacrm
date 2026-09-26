import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Intents live cutover harness safeguards', () => {
  it('does not override real live-test encryption secrets with unit-test dummies', () => {
    const config = readFileSync(
      new URL('../../../../vitest.config.ts', import.meta.url),
      'utf8',
    )
    expect(config).toContain('env: liveTestRequested')
    expect(config).toContain('? {}')
  })

  it('keeps TEST cutover gates manual, sequential, and explicitly confirmed', () => {
    const workflow = readFileSync(
      new URL(
        '../../../../.github/workflows/service-platform-intents-cutover-test.yml',
        import.meta.url,
      ),
      'utf8',
    )

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).toContain("expected='GENERATE_TEST_EVIDENCE'")
    expect(workflow).toContain("expected='ACTIVATE_TEST'")
    expect(workflow).toContain("expected='SEND_TEST_WHATSAPP'")
    expect(workflow).toContain("expected='ROLLBACK_TEST'")
    expect(workflow).toContain("environment: wacrm-test")
    expect(workflow).toContain("if: inputs.gate == 'transport'")
  })
})
