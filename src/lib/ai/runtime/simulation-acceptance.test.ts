import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENT_PLATFORM_REGISTRY } from '../tools/platform/current-domain-registry'
import { authorizeToolInvocation } from './tool-policy'

const features = {
  killSwitch: false,
  nativeToolsEnabled: true,
  proposalToolsEnabled: true,
}

describe('Phase 17 simulation acceptance', () => {
  it('routes evaluation through the real Agent Loop with simulation enabled and no transport send', () => {
    const source = readFileSync(
      new URL(
        '../../../app/api/ai-agents/[id]/revisions/[revisionId]/evaluate/route.ts',
        import.meta.url,
      ),
      'utf8',
    )

    expect(source).toContain('runAgentLoop({')
    expect(source).toContain('simulation: true')
    expect(source).not.toContain('engineSendText')
    expect(source).not.toContain('engineSendTemplate')
    expect(source).not.toContain('meta-send')
  })

  it('denies every model-visible mutating tool during simulation', () => {
    const mutating = CURRENT_PLATFORM_REGISTRY.listTools().filter(
      (tool) => tool.modelExposed && tool.permission !== 'read',
    )

    expect(mutating.length).toBeGreaterThan(0)

    for (const tool of mutating) {
      const plane = tool.allowedPlanes.includes('customer')
        ? ('customer' as const)
        : ('admin' as const)

      const result = authorizeToolInvocation({
        tool,
        permission: tool.permission,
        args: {},
        constraints: {},
        context: {
          plane,
          channel: 'whatsapp',
          simulation: true,
          agentPurpose:
            plane === 'admin' ? 'admin_operations' : 'customer_support',
          trustedAdminIdentityId:
            plane === 'admin' ? 'phase17-simulation-admin' : null,
          trustedAdminCapabilities:
            plane === 'admin' ? [...tool.requiredCapabilities] : [],
          features,
        },
      })

      expect(result.ok, tool.key).toBe(false)
      if (!result.ok) {
        expect(
          ['SIMULATION_WRITE_DENIED', 'DIRECT_WRITE_DENIED'],
          tool.key,
        ).toContain(result.code)
      }
    }
  })

  it('keeps evaluation persistence separate from business mutation tables', () => {
    const source = readFileSync(
      new URL(
        '../../../app/api/ai-agents/[id]/revisions/[revisionId]/evaluate/route.ts',
        import.meta.url,
      ),
      'utf8',
    )

    expect(source).toContain(".from('ai_agent_evaluation_runs')")
    for (const forbidden of [
      ".from('coverage_offers')",
      ".from('coverage_requests')",
      ".from('customer_intents')",
      ".from('change_requests')",
      ".from('business_event_outbox')",
      'createChangeRequest(',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
