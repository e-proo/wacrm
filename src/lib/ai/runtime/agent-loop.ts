import { supabaseAdmin } from '../admin-client'
import { loadEmbeddingsKey } from '../config'
import { buildSystemPrompt, MAX_OUTPUT_TOKENS } from '../defaults'
import { parseGeneration } from '../generate'
import { latestUserMessage } from '../query'
import { retrieveKnowledgeV2, renderKnowledgeForPrompt } from '../knowledge-v2'
import { loadRuntimeConnection } from '../connections/loader'
import type { ChatMessage } from '../types'
import { executeTool } from './dispatch'
import { getRegisteredTool } from './tool-registry'
import { validateToolArguments } from './tool-schema'
import { generateNativeAgentTurn, type NativeAgentMessage } from './native-agent-tools'
import { mergeConsecutive } from '../providers/shared'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { reserveRuntimeBudget, releaseRuntimeBudget, RuntimeBudgetError } from './runtime-budget'
import type { AiAgentRevision, RunPlane, ToolGrantPermission } from './multi-agent-types'

// Native structured-tool agent loop. There is intentionally no parser for
// ```tool blocks: provider prose can never become executable instructions.

export interface AgentLoopInput {
  accountId: string
  runId: string | null
  agentId: string
  agentPurpose: 'customer_support' | 'admin_operations' | 'custom'
  revision: AiAgentRevision
  messages: ChatMessage[]
  contactId: string | null
  conversationId: string | null
  sourceMessageId: string | null
  plane: RunPlane
  channel: 'whatsapp'
  trustedAdminIdentityId: string | null
  trustedAdminCapabilities: ReadonlyArray<string>
  simulation?: boolean
}

export interface AgentLoopResult {
  status: 'succeeded' | 'handoff' | 'failed'
  text: string | null
  toolCalls: Array<{ toolKey: string; round: number; ok: boolean }>
  handoffRequested: boolean
  inputTokens: number
  outputTokens: number
  error?: string
}

interface RuntimeGrant {
  permission: ToolGrantPermission
  toolVersion: number
  constraints: Record<string, unknown>
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { accountId, runId, revision } = input
  const db = supabaseAdmin()
  const auditCalls: AgentLoopResult['toolCalls'] = []
  let inputTokens = 0
  let outputTokens = 0

  try {
    const policy = await loadAccountRuntimePolicy(db, accountId)
    if (policy.killSwitch || !policy.multiAgentEnabled) return failed('runtime_disabled')
    if (input.plane === 'admin' && !policy.adminPlaneEnabled) return failed('admin_plane_disabled')

    // CRITICAL: generation credentials/model come from the frozen published
    // revision, not from account-global ai_configs.
    const connection = await loadRuntimeConnection(db, accountId, revision.providerConnectionId)

    // Embeddings are independent of chat activation. Do not load the account
    // chat config here: a revision-specific provider must still run when the
    // legacy account-global chat config is absent or disabled.
    const embeddings = await loadEmbeddingsKey(db, accountId)
    const knowledgeExcerpts = await retrieveKnowledgeV2(
      db,
      {
        accountId,
        agentRevisionId: revision.id,
        // A future service resolver can bind serviceId server-side. The model
        // never chooses knowledge-base ids or expands its own retrieval scope.
        serviceId: null,
        language: revision.languagePolicy === 'auto' ? null : revision.languagePolicy,
      },
      {
        embeddingsApiKey: embeddings.key,
        embeddingSetup: embeddings.embedSetup,
      },
      latestUserMessage(input.messages),
      5,
    )
    const knowledge = renderKnowledgeForPrompt(knowledgeExcerpts)

    const { data: grantRows, error: grantErr } = await db
      .from('ai_agent_tool_grants')
      .select('tool_key, tool_version, permission, constraints')
      .eq('account_id', accountId)
      .eq('agent_revision_id', revision.id)
    if (grantErr) throw grantErr

    const grants: Record<string, RuntimeGrant> = {}
    const permissionMap: Record<string, ToolGrantPermission> = {}
    const versionMap: Record<string, number> = {}
    const constraintsMap: Record<string, Record<string, unknown>> = {}
    for (const row of (grantRows ?? []) as Array<{
      tool_key: string
      tool_version: number
      permission: ToolGrantPermission
      constraints: Record<string, unknown> | null
    }>) {
      grants[row.tool_key] = {
        permission: row.permission,
        toolVersion: row.tool_version,
        constraints: row.constraints ?? {},
      }
      permissionMap[row.tool_key] = row.permission
      versionMap[row.tool_key] = row.tool_version
      constraintsMap[row.tool_key] = row.constraints ?? {}
    }

    const maxRounds = Math.max(Number.isFinite(revision.maxToolRounds) ? revision.maxToolRounds : 0, 0)
    const offeredTools = maxRounds > 0
      ? Object.entries(grants).flatMap(([key, grant]) => {
          const tool = getRegisteredTool(key)
          // Version mismatch is fail-closed and the stale tool is not offered.
          return tool && tool.version === grant.toolVersion ? [tool] : []
        })
      : []

    const roleFraming =
      input.agentPurpose === 'admin_operations'
        ? 'You are the operations assistant for a verified business administrator. Use only native tools offered by the runtime. Never claim a mutation occurred unless a change request was explicitly approved and executed.'
        : input.agentPurpose === 'customer_support'
          ? 'You are the business customer-service assistant. Answer from approved knowledge and read/proposal tools. Never expose internal-only fields and never claim an administrative write was performed.'
          : 'Answer using approved knowledge and native tools. Ask a concise clarifying question when needed.'

    const systemPrompt = buildSystemPrompt({
      userPrompt: [revision.systemPrompt ?? '', roleFraming].filter(Boolean).join('\n\n'),
      mode: 'auto_reply',
      knowledge,
    })

    // Reserve a conservative envelope before the first provider call. The
    // reservation is account-locked in SQL so concurrent webhook workers
    // cannot all pass the same budget check.
    try {
      await reserveRuntimeBudget({
        db,
        accountId,
        runId,
        estimatedInputTokens: Math.ceil(
          (systemPrompt.length + input.messages.reduce((n, m) => n + m.content.length, 0)) / 4,
        ),
        estimatedOutputTokens:
          (revision.maxOutputTokens ?? MAX_OUTPUT_TOKENS) * Math.max(1, maxRounds + 1),
      })
    } catch (err) {
      if (err instanceof RuntimeBudgetError && err.code.endsWith(':handoff')) {
        return {
          status: 'handoff', text: null, toolCalls: auditCalls,
          handoffRequested: true, inputTokens, outputTokens, error: err.code,
        }
      }
      throw err
    }

    // Normalize adjacent same-role turns before they reach provider-native
    // adapters. Anthropic requires alternating user/assistant roles; the same
    // normalization is harmless for OpenAI/Gemini and keeps simulations with
    // multiple user fixture lines valid.
    const messages: NativeAgentMessage[] = mergeConsecutive(input.messages).map((m) => ({ ...m }))
    let finalText: string | null = null
    let handoffRequested = false
    const rounds = Math.max(maxRounds, 1)

    for (let round = 1; round <= rounds; round++) {
      const turn = await generateNativeAgentTurn({
        connection,
        model: revision.model,
        systemPrompt,
        messages,
        tools: offeredTools,
        maxOutputTokens: revision.maxOutputTokens,
        temperature: revision.temperature,
      })
      inputTokens += turn.usage?.promptTokens ?? 0
      outputTokens += turn.usage?.completionTokens ?? 0

      const parsed = parseGeneration(turn.text, turn.usage)
      if (parsed.handoff) {
        handoffRequested = true
        finalText = parsed.text || null
        break
      }
      if (turn.toolCalls.length === 0) {
        finalText = parsed.text || null
        break
      }

      if (maxRounds === 0) throw new Error('provider returned a tool call while tool rounds are disabled')

      messages.push({ role: 'assistant_tool', content: parsed.text, calls: turn.toolCalls })
      for (const call of turn.toolCalls) {
        const grant = grants[call.toolKey]
        const tool = getRegisteredTool(call.toolKey)
        if (!grant || !tool || grant.toolVersion !== tool.version) {
          auditCalls.push({ toolKey: call.toolKey, round, ok: false })
          messages.push({
            role: 'tool', callId: call.id, toolKey: call.toolKey,
            content: JSON.stringify({ ok: false, code: 'TOOL_NOT_GRANTED_OR_STALE' }),
          })
          continue
        }

        const checked = validateToolArguments(tool, call.args)
        if (!checked.ok || !checked.value) {
          auditCalls.push({ toolKey: call.toolKey, round, ok: false })
          messages.push({
            role: 'tool', callId: call.id, toolKey: call.toolKey,
            content: JSON.stringify({ ok: false, code: 'INVALID_TOOL_ARGUMENTS', message: checked.error }),
          })
          continue
        }

        const outcome = await executeTool(
          {
            accountId,
            runId,
            actorUserId: null,
            revision,
            grants: permissionMap,
            grantVersions: versionMap,
            grantConstraints: constraintsMap,
            plane: input.plane,
            channel: input.channel,
            simulation: input.simulation === true,
            trustedAdminIdentityId: input.trustedAdminIdentityId,
            trustedAdminCapabilities: input.trustedAdminCapabilities,
            agentPurpose: input.agentPurpose,
            contactId: input.contactId,
            conversationId: input.conversationId,
            sourceMessageId: input.sourceMessageId,
            features: {
              killSwitch: policy.killSwitch,
              nativeToolsEnabled: policy.nativeToolsEnabled,
              proposalToolsEnabled: policy.proposalToolsEnabled,
            },
          },
          {
            toolKey: call.toolKey,
            permission: grant.permission,
            args: checked.value,
            round,
          },
        )
        auditCalls.push({ toolKey: call.toolKey, round, ok: outcome.result.ok })
        messages.push({
          role: 'tool', callId: call.id, toolKey: call.toolKey,
          content: JSON.stringify(outcome.result),
        })
      }

      if (round === rounds) {
        // Final turn is tool-free: provider cannot request another action after
        // the configured tool-round budget is exhausted.
        const last = await generateNativeAgentTurn({
          connection,
          model: revision.model,
          systemPrompt,
          messages,
          tools: [],
          maxOutputTokens: revision.maxOutputTokens,
          temperature: revision.temperature,
        })
        inputTokens += last.usage?.promptTokens ?? 0
        outputTokens += last.usage?.completionTokens ?? 0
        const parsedLast = parseGeneration(last.text, last.usage)
        finalText = parsedLast.text || null
        handoffRequested = parsedLast.handoff
      }
    }

    return {
      status: handoffRequested ? 'handoff' : finalText ? 'succeeded' : 'failed',
      text: finalText,
      toolCalls: auditCalls,
      handoffRequested,
      inputTokens,
      outputTokens,
    }
  } catch (err) {
    console.error('[agent loop] failed:', err)
    return failed(err instanceof Error ? err.message : 'unknown')
  } finally {
    await releaseRuntimeBudget(db, runId)
  }

  function failed(error: string): AgentLoopResult {
    return {
      status: 'failed', text: null, toolCalls: auditCalls,
      handoffRequested: false, inputTokens, outputTokens, error,
    }
  }
}

export function describeLoopFailure(result: AgentLoopResult): string {
  return result.error ?? 'no_final_text'
}
