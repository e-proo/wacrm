import { describe, expect, it, vi } from 'vitest'
import type { AgentTaskTypeManifest } from './contracts'
import {
  authorizeAgentRevisionForTask,
  BASE_OUTBOUND_AGENT_CAPABILITIES,
  inheritAgentRevisionCapabilities,
  PLATFORM_AGENT_CAPABILITIES,
  validateTaskManifestToolPolicy,
} from './capability-policy'
import { CURRENT_PLATFORM_REGISTRY } from '../tools/platform/current-domain-registry'

function coverageTask(
  over: Partial<AgentTaskTypeManifest> = {},
): AgentTaskTypeManifest {
  return {
    key: 'coverage.sourcing',
    version: 1,
    domain: 'coverage',
    title: 'Coverage sourcing',
    description: 'Contact eligible suppliers for coverage supply.',
    requiredAgentCapabilities: ['coverage.sourcing'],
    allowedChannels: ['whatsapp'],
    targetResolver: 'coverage.supplier_candidates',
    allowedTools: [
      { key: 'coverage.get_rates', version: 1 },
      { key: 'coverage.propose_offer', version: 2 },
    ],
    requiredTaskApproval: 'task',
    followupPolicy: {
      maxFollowups: 2,
      minimumIntervalMinutes: 60,
      maximumIntervalMinutes: 1440,
      stopOnReply: true,
      stopOnOptOut: true,
      stopOnBusinessOutcome: true,
    },
    maxTargets: 10,
    completionPolicy: {
      key: 'coverage.sourcing_completion',
      version: 1,
      config: {},
    },
    messagePolicy: {
      key: 'coverage.sourcing_message',
      version: 1,
      config: {},
    },
    ...over,
  }
}

describe('Agent Task capability policy', () => {
  it('defines explicit generic outreach capabilities', () => {
    expect(PLATFORM_AGENT_CAPABILITIES).toEqual(
      expect.arrayContaining([
        'agent_tasks.read',
        'agent_tasks.manage',
        'outreach.read',
        'outreach.start',
        'outreach.pause',
        'contacts.target_read',
      ]),
    )
    expect(BASE_OUTBOUND_AGENT_CAPABILITIES).toEqual([
      'agent_tasks.read',
      'outreach.start',
      'contacts.target_read',
    ])
  })

  it('authorizes only the exact task-scoped intersection of grants and capabilities', () => {
    const result = authorizeAgentRevisionForTask({
      manifest: coverageTask(),
      revisionCapabilities: [
        ...BASE_OUTBOUND_AGENT_CAPABILITIES,
        'coverage.sourcing',
        'coverage.read',
        'coverage.propose',
        'services.read',
      ],
      revisionToolGrants: [
        {
          toolKey: 'coverage.get_rates',
          toolVersion: 1,
          permission: 'read',
        },
        {
          toolKey: 'coverage.propose_offer',
          toolVersion: 2,
          permission: 'propose',
        },
        {
          // Globally granted to the revision but outside this Task Type.
          toolKey: 'services.search',
          toolVersion: 1,
          permission: 'read',
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.allowedTools).toEqual([
        { key: 'coverage.get_rates', version: 1 },
        { key: 'coverage.propose_offer', version: 2 },
      ])
      expect(result.allowedTools).not.toContainEqual({
        key: 'services.search',
        version: 1,
      })
    }
  })

  it('fails closed when the outbound baseline capability is missing', () => {
    const result = authorizeAgentRevisionForTask({
      manifest: coverageTask({ allowedTools: [] }),
      revisionCapabilities: [
        'agent_tasks.read',
        'contacts.target_read',
        'coverage.sourcing',
      ],
      revisionToolGrants: [],
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_CAPABILITY_MISSING',
      missingCapabilities: ['outreach.start'],
    })
  })

  it('requires capabilities declared by task-scoped platform tools', () => {
    const result = authorizeAgentRevisionForTask({
      manifest: coverageTask({
        allowedTools: [{ key: 'coverage.get_rates', version: 1 }],
      }),
      revisionCapabilities: [
        ...BASE_OUTBOUND_AGENT_CAPABILITIES,
        'coverage.sourcing',
      ],
      revisionToolGrants: [
        {
          toolKey: 'coverage.get_rates',
          toolVersion: 1,
          permission: 'read',
        },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_CAPABILITY_MISSING',
      missingCapabilities: ['coverage.read'],
    })
  })

  it('rejects stale, server-only, or wrong-plane task tool scopes', () => {
    expect(
      validateTaskManifestToolPolicy(
        coverageTask({
          allowedTools: [{ key: 'coverage.get_rates', version: 999 }],
        }),
      ),
    ).toContain('TASK_TOOL_NOT_REGISTERED:coverage.get_rates@999')

    expect(
      validateTaskManifestToolPolicy(
        coverageTask({
          allowedTools: [
            { key: 'coverage.admin_list_offers', version: 1 },
          ],
        }),
      ),
    ).toContain(
      'TASK_TOOL_CUSTOMER_PLANE_DENIED:coverage.admin_list_offers@1',
    )
  })

  it('keeps raw message sending out of the model-visible platform registry', () => {
    const rawSend = CURRENT_PLATFORM_REGISTRY.listTools().filter((tool) =>
      /^(?:whatsapp|messaging|messages|outreach)\.(?:send|send_|deliver|dispatch)/.test(
        tool.key,
      ),
    )
    expect(rawSend).toEqual([])
  })
})


describe('Agent Revision capability inheritance', () => {
  it('copies the exact published capability set into a new draft through the atomic RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 3, error: null })
    const db = {
      from(table: string) {
        expect(table).toBe('ai_agent_revision_capabilities')
        return {
          select() {
            return this
          },
          eq() {
            return this
          },
          order() {
            return Promise.resolve({
              data: [
                { capability: 'agent_tasks.read' },
                { capability: 'contacts.target_read' },
                { capability: 'outreach.start' },
              ],
              error: null,
            })
          },
        }
      },
      rpc,
    }

    await expect(
      inheritAgentRevisionCapabilities(db as never, {
        accountId: 'acc-1',
        agentId: 'agent-1',
        sourceRevisionId: 'rev-published',
        targetRevisionId: 'rev-draft',
        actorUserId: 'user-1',
      }),
    ).resolves.toBe(3)

    expect(rpc).toHaveBeenCalledWith(
      'replace_ai_agent_revision_capabilities',
      {
        p_account_id: 'acc-1',
        p_agent_id: 'agent-1',
        p_revision_id: 'rev-draft',
        p_capabilities: [
          'agent_tasks.read',
          'contacts.target_read',
          'outreach.start',
        ],
        p_granted_by: 'user-1',
      },
    )
  })

  it('does not invoke the replacement RPC when the source has no capabilities', async () => {
    const rpc = vi.fn()
    const db = {
      from() {
        return {
          select() {
            return this
          },
          eq() {
            return this
          },
          order() {
            return Promise.resolve({ data: [], error: null })
          },
        }
      },
      rpc,
    }

    await expect(
      inheritAgentRevisionCapabilities(db as never, {
        accountId: 'acc-1',
        agentId: 'agent-1',
        sourceRevisionId: 'rev-published',
        targetRevisionId: 'rev-draft',
        actorUserId: 'user-1',
      }),
    ).resolves.toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })
})
