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

  it('keeps WhatsApp manual while allowing one-shot evidence + activation on a narrow push trigger', () => {
    const workflow = readFileSync(
      new URL(
        '../../../../.github/workflows/service-platform-intents-cutover-test.yml',
        import.meta.url,
      ),
      'utf8',
    )

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('push:')
    expect(workflow).toContain(
      ".github/cutover/intents-evidence-activation.trigger",
    )
    expect(workflow).toContain("expected='GENERATE_TEST_EVIDENCE'")
    expect(workflow).toContain("expected='ACTIVATE_TEST'")
    expect(workflow).toContain("expected='SEND_TEST_WHATSAPP'")
    expect(workflow).toContain("expected='ROLLBACK_TEST'")
    expect(workflow).toContain("environment: wacrm-test")
    expect(workflow).toContain("if: inputs.gate == 'transport'")
    expect(workflow).toContain("if: github.event_name == 'push'")
    expect(workflow).toContain('AUTO — Generate 4/4 shadow parity evidence')
    expect(workflow).toContain('AUTO — Activate controlled Intents route')
    expect(workflow).not.toContain('AUTO — Send')

  })
})
