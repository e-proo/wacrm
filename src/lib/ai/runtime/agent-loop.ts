import { supabaseAdmin } from '../admin-client'
import { loadAiConfig } from '../config'
import { buildSystemPrompt } from '../defaults'
import { generateReply } from '../generate'
import { latestUserMessage } from '../query'
import { retrieveKnowledge } from '../knowledge'
import type { ChatMessage } from '../types'
import { executeTool } from './dispatch'
import type { AiAgentRevision } from './multi-agent-types'

// ============================================================
// Agent loop — the REAL model + tool-calling cycle (Phase: loop).
//
// Replaces the `skipped (legacy_path_only)` placeholder: the run
// now actually generates a reply through the account's provider,
// optionally calling registered tools, and returns the final text.
//
// Safety rails (all enforced here, not by the model):
//   • max_tool_rounds comes from the published revision.
//   • executeTool re-validates registry + grant + permission per
//     round (DENY BY DEFAULT).
//   • On any provider/tool error the loop degrades to a safe
//     fallback text or a handoff — never a hallucinated answer.
//   • The SENDING of the reply stays OUTSIDE this module: the
//     caller decides channel + idempotency.
// ============================================================

export interface AgentLoopInput {
  accountId: string
  runId: string | null
  agentId: string
  /** The agent's purpose drives the role framing in the prompt. */
  agentPurpose: 'customer_support' | 'admin_operations' | 'custom'
  revision: AiAgentRevision
  /** Chat history, oldest first (from buildConversationContext). */
  messages: ChatMessage[]
  contactId: string | null
}

export interface AgentLoopResult {
  status: 'succeeded' | 'handoff' | 'failed'
  /** Final user-facing text (null on handoff-with-no-text). */
  text: string | null
  toolCalls: Array<{ toolKey: string; round: number; ok: boolean }>
  handoffRequested: boolean
  error?: string
}

interface ToolCallRequest {
  toolKey: string
  args: Record<string, unknown>
}

/**
 * Parse a structured tool-call block out of the model's text.
 * Protocol: the model emits
 *   ```tool
 *   {"tool": "services.search", "args": { ... }}
 *   ```
 * Text outside the block is treated as the final answer.
 */
export function parseToolCall(raw: string): { call: ToolCallRequest | null; text: string } {
  const fence = /```tool\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let call: ToolCallRequest | null = null
  const textParts: string[] = []
  let lastIndex = 0
  while ((match = fence.exec(raw)) !== null) {
    textParts.push(raw.slice(lastIndex, match.index))
    lastIndex = match.index + match[0].length
    if (call) continue // only the first block is honored per turn
    try {
      const parsed = JSON.parse(match[1].trim()) as { tool?: string; args?: Record<string, unknown> }
      if (parsed.tool && typeof parsed.tool === 'string') {
        call = { toolKey: parsed.tool, args: parsed.args ?? {} }
      }
    } catch {
      // Malformed block: dropped from text, never crashes the loop.
    }
  }
  textParts.push(raw.slice(lastIndex))
  return { call, text: textParts.join('').trim() }
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { accountId, runId, revision } = input
  const db = supabaseAdmin()
  const toolCalls: AgentLoopResult['toolCalls'] = []

  try {
    // 1) Provider config for the account (BYO key / connection).
    const config = await loadAiConfig(db, accountId)
    if (!config) {
      console.error('[agent loop] no provider config for account ' + accountId)
      return {
        status: 'failed',
        text: null,
        toolCalls,
        handoffRequested: true,
        error: 'no_provider_config',
      }
    }
    console.info(`[agent loop] provider=${config.chat?.protocol ?? config.provider} model=${config.chat?.model ?? config.model}`)

    // 2) Knowledge grounding, scoped to THIS revision's assigned
    //    chunks when any exist; falls back to the account KB.
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(input.messages),
      5,
      { scopeRevisionId: revision.id },
    )

    // 3) System prompt = user instructions + agent role framing.
    // The framing explicitly counters the base prompt's aggressive
    // handoff default: answer-first from knowledge/tools, ask a
    // clarifying question when a detail is missing, and reserve
    // handoff for explicit human requests / out-of-scope asks.
    const roleFraming =
      input.agentPurpose === 'admin_operations'
        ? 'You are the operations assistant for the business owner, reachable only on the verified admin channel. Complete the requested task with the tools and knowledge you have. Hand off only for tasks outside your registered tools — and say exactly what is missing.'
        : input.agentPurpose === 'customer_support'
          ? 'You ARE the business assistant described below. ALWAYS attempt an answer first: use the knowledge excerpts and any tool results provided. If one specific detail is missing, ask the customer a short clarifying question instead of handing off. Hand off (HANDOFF) ONLY when the customer explicitly demands a human, is abusive, or asks for something clearly outside this business.'
          : 'Answer using the knowledge and tools provided; ask clarifying questions when details are missing.'

    const systemPrompt = buildSystemPrompt({
      userPrompt: [revision.systemPrompt ?? '', roleFraming]
        .filter(Boolean)
        .join('\n\n'),
      mode: 'auto_reply',
      knowledge,
    })
    console.info(`[agent loop] knowledge=${knowledge.length} chunks`)

    // 4) The bounded tool-calling loop.
    // Defensive: a NaN/undefined cap must never silently skip the
    // whole loop (that bug shipped once — rounds=undefined made
    // Math.max(undefined,1) === NaN and the for-loop ran zero times).
    const maxRounds = Math.max(Number.isFinite(revision.maxToolRounds) ? revision.maxToolRounds : 0, 1)
    const messages = [...input.messages]
    let finalText: string | null = null
    let handoffRequested = false

    for (let round = 1; round <= Math.max(maxRounds, 1); round++) {
      const { text, handoff } = await generateReply({
        config,
        systemPrompt,
        messages,
      })
      if (handoff) {
        handoffRequested = true
        finalText = text || null
        break
      }

      const { call, text: cleaned } = parseToolCall(text)
      if (!call) {
        finalText = cleaned || null
        break
      }

      // Execute the tool under the revision's grant.
      const outcome = await executeTool(
        {
          accountId,
          runId,
          actorUserId: null,
          revision,
        },
        {
          toolKey: call.toolKey,
          // Tool permission is derived from the registry at execute
          // time; the model only names the tool.
          permission: 'read',
          args: call.args,
          round,
        },
      )
      toolCalls.push({ toolKey: call.toolKey, round, ok: outcome.result.ok })

      // Propose-class tools return a change-request payload — the
      // model must relay it to an ADMIN, never promise the customer.
      // We surface the result as a tool observation for the next
      // model turn, then continue the loop.
      messages.push({
        role: 'assistant',
        content: `\`\`\`tool\n${JSON.stringify({ tool: call.toolKey, args: call.args })}\n\`\`\``,
      })
      messages.push({
        role: 'user',
        content: `[tool result] ${JSON.stringify(outcome.result)}`,
      })

      if (round === Math.max(maxRounds, 1)) {
        // Rounds exhausted — force a final answer turn.
        const last = await generateReply({ config, systemPrompt, messages })
        finalText = last.text || null
        handoffRequested = last.handoff
      }
    }

    return {
      status: handoffRequested ? 'handoff' : finalText ? 'succeeded' : 'failed',
      text: finalText,
      toolCalls,
      handoffRequested,
    }
  } catch (err) {
    console.error('[agent loop] failed:', err)
    return {
      status: 'failed',
      text: null,
      toolCalls,
      handoffRequested: false,
      error: err instanceof Error ? err.message : 'unknown',
    }
  }
}

// Guard: when the loop finishes without text and without an error
// (rounds consumed, no final answer), surface WHY in the status.
export function describeLoopFailure(result: AgentLoopResult): string {
  return result.error ?? 'no_final_text'
}
