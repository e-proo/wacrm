import { supabaseAdmin } from '../admin-client'
import { loadEmbeddingsKey } from '../config'
import { buildSystemPrompt, MAX_OUTPUT_TOKENS } from '../defaults'
import { parseGeneration } from '../generate'
import { latestUserMessage } from '../query'
import { retrieveKnowledgeV2, renderKnowledgeForPrompt } from '../knowledge-v2'
import { loadRuntimeConnection } from '../connections/loader'
import type { ChatMessage } from '../types'
import { executeTool } from './dispatch'
import { validateToolArguments } from './tool-schema'
import { generateNativeAgentTurn, type NativeAgentMessage } from './native-agent-tools'
import { mergeConsecutive } from '../providers/shared'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { reserveRuntimeBudget, releaseRuntimeBudget, RuntimeBudgetError } from './runtime-budget'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import {
  coverageRegionIdsFromArgs,
  guardCoverageLegWording,
  isCoverageLegGuardedTool,
  requiresFreshCoverageRates,
  type CoverageLegRegionAliases,
} from './coverage-leg-wording-guard'
import { requiresFreshFxRate } from './fx-current-rate-guard'
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

function coverageClarification(text: string): string {
  return /[\u0600-\u06FF]/.test(text)
    ? 'للتأكد قبل التسعير: أين ستسلّم/تدفع المبلغ وبأي طريقة، وأين تريد الاستلام وبأي طريقة؟'
    : 'Before I quote this coverage request, please confirm where/how you will pay and where/how you want to receive.'
}

function fxCurrentRateUnavailable(text: string): string {
  return /[\u0600-\u06FF]/.test(text)
    ? 'تعذر عليّ التحقق من سعر الصرف الحالي من المصدر المباشر، لذلك لن أعطيك سعراً من المحادثة السابقة أو من معلومات غير محدثة.'
    : 'I could not verify the current exchange rate from the live source, so I will not quote a rate from conversation history or stale information.'
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
    const latestCustomerText = latestUserMessage(input.messages)
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
      latestCustomerText,
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
    const offeredTools = maxRounds > 0 && policy.nativeToolsEnabled
      ? Object.entries(grants).flatMap(([key, grant]) => {
          const manifest = getCurrentPlatformTool(key, grant.toolVersion)
          // Offer only tools that can actually pass the deterministic runtime
          // authorization boundary. Stale/cross-plane grants remain frozen for
          // audit history but are invisible to the model instead of causing a
          // predictable TOOL_PLANE_DENIED / ADMIN_CAPABILITY_DENIED round.
          if (!manifest || !manifest.modelExposed || manifest.serverOnly) return []
          if (manifest.permission !== grant.permission) return []
          if (!manifest.allowedPlanes.includes(input.plane)) return []
          if (grant.permission === 'propose' && !policy.proposalToolsEnabled) return []
          if (
            input.plane === 'admin' &&
            manifest.requiredCapabilities.some(
              (capability) => !input.trustedAdminCapabilities.includes(capability),
            )
          ) return []
          return [manifest]
        })
      : []

    if (input.plane === 'admin') {
      const hiddenCount = Object.keys(grants).length - offeredTools.length
      console.info(
        `[agent loop] admin tool readiness offered=${offeredTools.length} hidden=${hiddenCount} capabilities=${input.trustedAdminCapabilities.length}`,
      )
    }

    const coverageRateTool = offeredTools.find((tool) => tool.key === 'coverage.get_rates') ?? null
    const coverageRateRequired = Boolean(
      coverageRateTool && requiresFreshCoverageRates(latestCustomerText),
    )
    let coverageRateSatisfied = !coverageRateRequired

    const fxRateQuery = requiresFreshFxRate(latestCustomerText)
    const fxRateTool = offeredTools.find((tool) => tool.key === 'exchange_rates.get_current') ?? null
    if (fxRateQuery && !fxRateTool) {
      console.warn('[agent loop] current FX query cannot access exchange_rates.get_current; failing closed')
      return {
        status: 'handoff',
        text: fxCurrentRateUnavailable(latestCustomerText),
        toolCalls: auditCalls,
        handoffRequested: true,
        inputTokens,
        outputTokens,
        error: 'FX_CURRENT_RATE_TOOL_UNAVAILABLE',
      }
    }
    const fxRateRequired = fxRateQuery && Boolean(fxRateTool)
    let fxRateSatisfied = !fxRateRequired

    const resolveCoverageLegAliases = async (
      toolKey: string,
      args: Record<string, unknown>,
    ): Promise<CoverageLegRegionAliases> => {
      if (!isCoverageLegGuardedTool(toolKey)) return {}
      const { payRegionId, receiveRegionId } = coverageRegionIdsFromArgs(args)
      const ids = [...new Set([payRegionId, receiveRegionId].filter((id): id is string => Boolean(id)))]
      if (ids.length === 0) return {}

      const { data, error } = await db
        .from('coverage_regions')
        .select('id, name, code')
        .eq('account_id', accountId)
        .in('id', ids)
      if (error) {
        console.warn('[agent loop] could not resolve coverage region aliases for wording guard')
        return {}
      }

      const rows = (data ?? []) as Array<{ id: string; name: string | null; code: string | null }>
      const byId = new Map(rows.map((row) => [row.id, row]))
      const aliasesFor = (id: string | null): string[] => {
        if (!id) return []
        const row = byId.get(id)
        return row ? [row.name, row.code].filter((value): value is string => Boolean(value)) : []
      }
      return {
        pay: aliasesFor(payRegionId),
        receive: aliasesFor(receiveRegionId),
      }
    }

    const roleFraming =
      input.agentPurpose === 'admin_operations'
        ? 'You are the operations assistant for a verified business administrator. Use native READ tools for current services, rates, coverage, requests, and offers whenever relevant. Concrete/current FX rates must come from exchange_rates.get_current, never conversation history or knowledge text. Never use customer-style handoff merely because live data was needed. Never claim a mutation occurred unless a change request was explicitly approved and executed.'
        : input.agentPurpose === 'customer_support'
          ? 'You are the business customer-service assistant. Answer from approved knowledge and read/proposal tools. Concrete/current FX rates must come from exchange_rates.get_current, never conversation history or knowledge text. When a READ tool succeeds, answer from that authoritative result instead of handing off. Never expose internal-only fields and never claim an administrative write was performed.'
          : 'Answer using approved knowledge and native tools. For a concrete/current FX rate use exchange_rates.get_current rather than history or knowledge text. Ask a concise clarifying question when needed.'

    const systemPrompt = buildSystemPrompt({
      userPrompt: [revision.systemPrompt ?? '', roleFraming].filter(Boolean).join('\n\n'),
      mode: 'auto_reply',
      audience: input.agentPurpose === 'admin_operations' ? 'admin' : 'customer',
      nativeToolsAvailable: offeredTools.length > 0,
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
    let hasAuthoritativeReadResult = false
    const rounds = Math.max(maxRounds, 1)

    const recoverAfterAuthoritativeRead = async () => {
      const recovery = await generateNativeAgentTurn({
        connection,
        model: revision.model,
        systemPrompt:
          systemPrompt +
          '\n\nRuntime grounding rule: a READ tool already returned authoritative safe-to-show data for this turn. Answer from that tool result now. Do not hand off merely because live data was required. If the tool result says the data is unpublished or unavailable, say that explicitly.',
        messages,
        tools: [],
        maxOutputTokens: revision.maxOutputTokens,
        temperature: revision.temperature,
      })
      inputTokens += recovery.usage?.promptTokens ?? 0
      outputTokens += recovery.usage?.completionTokens ?? 0
      return parseGeneration(recovery.text, recovery.usage)
    }

    for (let round = 1; round <= rounds; round++) {
      const forcedFreshTool = coverageRateRequired && !coverageRateSatisfied && coverageRateTool
        ? coverageRateTool
        : fxRateRequired && !fxRateSatisfied && fxRateTool
          ? fxRateTool
          : null
      const toolsForTurn = forcedFreshTool ? [forcedFreshTool] : offeredTools

      let turn = await generateNativeAgentTurn({
        connection,
        model: revision.model,
        systemPrompt,
        messages,
        tools: toolsForTurn,
        maxOutputTokens: revision.maxOutputTokens,
        temperature: revision.temperature,
      })
      inputTokens += turn.usage?.promptTokens ?? 0
      outputTokens += turn.usage?.completionTokens ?? 0

      if (coverageRateRequired && !coverageRateSatisfied && coverageRateTool && turn.toolCalls.length === 0) {
        console.info('[agent loop] concrete coverage query attempted without coverage.get_rates; forcing authoritative read')
        turn = await generateNativeAgentTurn({
          connection,
          model: revision.model,
          systemPrompt:
            systemPrompt +
            '\n\nRuntime requirement: the latest message is a NEW concrete coverage quote/direction request. Conversation history is NOT authoritative for a new coverage rate or commission. You MUST call coverage.get_rates now using the customer pay and receive legs from the latest message. Do not answer with a rate, commission, direction, or availability before that tool succeeds.',
          messages,
          tools: [coverageRateTool],
          maxOutputTokens: revision.maxOutputTokens,
          temperature: revision.temperature,
        })
        inputTokens += turn.usage?.promptTokens ?? 0
        outputTokens += turn.usage?.completionTokens ?? 0
        if (turn.toolCalls.length === 0) {
          console.warn('[agent loop] provider refused required coverage.get_rates call')
          finalText = coverageClarification(latestCustomerText)
          break
        }
      }

      if (
        fxRateRequired &&
        !fxRateSatisfied &&
        fxRateTool &&
        turn.toolCalls.length === 0
      ) {
        console.info('[agent loop] concrete FX query attempted without exchange_rates.get_current; forcing authoritative read')
        turn = await generateNativeAgentTurn({
          connection,
          model: revision.model,
          systemPrompt:
            systemPrompt +
            '\n\nRuntime requirement: the latest message asks for a CURRENT exchange rate. Conversation history and retrieved knowledge are NOT authoritative for current FX prices. You MUST call exchange_rates.get_current now for the explicit pair and the customer buy/sell side. If the pair or side is unclear, do not invent it. Do not answer with a numeric rate before the tool succeeds.',
          messages,
          tools: [fxRateTool],
          maxOutputTokens: revision.maxOutputTokens,
          temperature: revision.temperature,
        })
        inputTokens += turn.usage?.promptTokens ?? 0
        outputTokens += turn.usage?.completionTokens ?? 0
        if (turn.toolCalls.length === 0) {
          console.warn('[agent loop] provider refused required exchange_rates.get_current call')
          finalText = fxCurrentRateUnavailable(latestCustomerText)
          break
        }
      }

      const parsed = parseGeneration(turn.text, turn.usage)
      if (parsed.handoff) {
        if (hasAuthoritativeReadResult) {
          const recovered = await recoverAfterAuthoritativeRead()
          if (!recovered.handoff && recovered.text) {
            handoffRequested = false
            finalText = recovered.text
            break
          }
        }
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
        const tool = grant
          ? getCurrentPlatformTool(call.toolKey, grant.toolVersion)
          : null
        if (!grant || !tool) {
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

        const coverageLegAliases = await resolveCoverageLegAliases(call.toolKey, checked.value)
        const coverageLegGuard = guardCoverageLegWording(
          call.toolKey,
          checked.value,
          latestCustomerText,
          coverageLegAliases,
        )
        if (!coverageLegGuard.ok) {
          auditCalls.push({ toolKey: call.toolKey, round, ok: false })
          console.info(
            `[agent loop] tool=${call.toolKey} round=${round} ok=false code=${coverageLegGuard.code} safe=true`,
          )
          messages.push({
            role: 'tool', callId: call.id, toolKey: call.toolKey,
            content: JSON.stringify({
              ok: false,
              code: coverageLegGuard.code,
              safe_to_show: true,
              message: coverageLegGuard.message,
            }),
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
        console.info(
          `[agent loop] tool=${call.toolKey} round=${round} ok=${outcome.result.ok} code=${outcome.result.code ?? 'OK'} safe=${outcome.result.safe_to_show}`,
        )
        if (call.toolKey === 'coverage.get_rates' && outcome.result.ok) {
          coverageRateSatisfied = true
        }
        if (call.toolKey === 'exchange_rates.get_current' && outcome.result.ok) {
          fxRateSatisfied = true
        }
        if (
          grant.permission === 'read' &&
          outcome.result.ok &&
          outcome.result.safe_to_show &&
          outcome.result.data !== null
        ) {
          hasAuthoritativeReadResult = true
        }
        messages.push({
          role: 'tool', callId: call.id, toolKey: call.toolKey,
          content: JSON.stringify(outcome.result),
        })
      }

      if (round === rounds) {
        if (coverageRateRequired && !coverageRateSatisfied) {
          finalText = coverageClarification(latestCustomerText)
          break
        }
        if (fxRateRequired && !fxRateSatisfied) {
          finalText = fxCurrentRateUnavailable(latestCustomerText)
          break
        }
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
        if (handoffRequested && hasAuthoritativeReadResult) {
          const recovered = await recoverAfterAuthoritativeRead()
          if (!recovered.handoff && recovered.text) {
            finalText = recovered.text
            handoffRequested = false
          }
        }
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
