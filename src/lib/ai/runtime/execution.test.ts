import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  mapAgentLoopToExecutionResult,
  type AgentExecutionContext,
} from './execution'

describe('Agent Execution Runtime', () => {
  it('maps the shared agent loop into mode-neutral execution outcomes', () => {
    expect(
      mapAgentLoopToExecutionResult(
        {
          status: 'succeeded',
          text: 'hello',
          toolCalls: [{ toolKey: 'services.search', round: 1, ok: true }],
          handoffRequested: false,
          inputTokens: 10,
          outputTokens: 4,
        },
        'latest',
      ),
    ).toMatchObject({
      status: 'message_ready',
      customerMessage: 'hello',
      latestUserMessage: 'latest',
      usage: { inputTokens: 10, outputTokens: 4 },
    })

    expect(
      mapAgentLoopToExecutionResult(
        {
          status: 'handoff',
          text: null,
          toolCalls: [],
          handoffRequested: true,
          inputTokens: 1,
          outputTokens: 0,
          error: 'needs_human',
        },
        'latest',
      ),
    ).toMatchObject({
      status: 'needs_human',
      error: 'needs_human',
    })

    expect(
      mapAgentLoopToExecutionResult(
        {
          status: 'failed',
          text: null,
          toolCalls: [],
          handoffRequested: false,
          inputTokens: 0,
          outputTokens: 0,
          error: 'provider_failed',
        },
        '',
      ),
    ).toMatchObject({
      status: 'failed',
      error: 'provider_failed',
    })
  })

  it('supports inbound, outbound and simulation through one context contract', () => {
    const base: Omit<AgentExecutionContext, 'mode'> = {
      accountId: 'acc',
      runId: 'run',
      agentId: 'agent',
      revisionId: 'rev',
      conversationId: 'conv',
      contactId: 'contact',
      plane: 'customer',
      channel: 'whatsapp',
    }

    for (const mode of ['inbound', 'outbound', 'simulation'] as const) {
      const context: AgentExecutionContext = { ...base, mode }
      expect(context.mode).toBe(mode)
    }
  })

  it('keeps runAgentLoop as the only model/tool loop', () => {
    const execution = readFileSync(
      new URL('./execution.ts', import.meta.url),
      'utf8',
    )
    const dispatch = readFileSync(
      new URL('./dispatch.ts', import.meta.url),
      'utf8',
    )
    const worker = readFileSync(
      new URL('./worker.ts', import.meta.url),
      'utf8',
    )
    const files = execution + '\n' + dispatch

    expect(execution).toContain("import { runAgentLoop")
    expect(execution).toContain('authorizeStoredAgentTask')
    expect(execution).toContain('taskAllowedTools')
    expect(execution).not.toContain('engineSendText')
    expect(dispatch).toContain('runClaimedAgentExecution')
    expect(dispatch).not.toContain("import { runAgentLoop")
    expect(worker).toContain(".eq('run_mode', 'inbound')")
    expect(files).not.toContain('runOutboundAgentLoop')
  })
})
