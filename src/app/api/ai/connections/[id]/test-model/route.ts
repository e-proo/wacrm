import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadRuntimeConnection } from '@/lib/ai/connections/loader'
import { getAdapter } from '@/lib/ai/providers/registry'
import { aiRequestTimeoutMs } from '@/lib/ai/defaults'
import { AiError } from '@/lib/ai/types'

const FEATURE_FLAG_ON = process.env.AI_MULTI_PROVIDER_ENABLED === 'true'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/connections/:id/test-model  (admin+)
 *
 * The SECOND half of ADR-006: proving one specific model can generate
 * (a discovery probe never proves that — FR-MOD-*; the reverse also
 * holds: a /models 404 must not block a manual model, which is exactly
 * what the Phase 03 gate fixture covers). Explicit, server-side,
 * tiny, contains NO customer data (docs §11), rate-limited separately
 * from discovery, and never retried (ADR-012).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    if (!FEATURE_FLAG_ON) {
      return NextResponse.json(
        { error: 'Multi-provider connections are not enabled on this deployment.' },
        { status: 404 },
      )
    }
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id' }, { status: 400 })
    }

    // Its own tighter bucket — this one spends generation quota.
    const limit = checkRateLimit(`ai-test-model:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const capability = body.capability === 'embeddings' ? 'embeddings' : body.capability === 'chat' ? 'chat' : null
    if (!capability) {
      return NextResponse.json({ error: 'capability must be "chat" or "embeddings"' }, { status: 400 })
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model || model.length > 200) {
      return NextResponse.json({ error: 'model is required (max 200 chars)' }, { status: 400 })
    }

    const conn = await loadRuntimeConnection(supabase, accountId, id).catch(() => null)
    if (!conn) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    }

    const adapter = getAdapter(conn.protocol)

    let result: { text: string; usage: import('@/lib/ai/types').AiUsage | null }
    try {
      if (capability === 'embeddings') {
        if (!adapter.embed) {
          return NextResponse.json(
            { error: { code: 'AI_UNSUPPORTED_CAPABILITY', message: 'Embeddings are not available for this connection.', retryable: false } },
            { status: 400 },
          )
        }
        // Probe only — observed length is returned for the admin to see;
        // no vector is written anywhere until Phase 05 wires the KB.
        const [vector] = await adapter.embed(
          {
            apiKey: conn.apiKey,
            timeoutMs: aiRequestTimeoutMs(),
            apiRoot: conn.apiRoot,
            customEndpoint: conn.customEndpoint,
          },
          { model, inputs: ['ping'] },
        )
        return NextResponse.json({
          ok: true,
          capability: 'embeddings',
          model,
          observed_dimensions: vector.length,
          verified_at: new Date().toISOString(),
        })
      }

      result = await adapter.generate(
        {
          apiKey: conn.apiKey,
          timeoutMs: aiRequestTimeoutMs(),
          apiRoot: conn.apiRoot,
          customEndpoint: conn.customEndpoint,
        },
        {
          model,
          // Fixed, minimal, customer-free probe (docs §11).
          systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
          messages: [{ role: 'user', content: 'ping' }],
        },
      )
    } catch (err) {
      if (err instanceof AiError) {
        // Keep provider details OUT of the response beyond the already
        // safe AiError.code; map to the public envelope.
        const blocked = err.code === 'endpoint_blocked'
        const code = blocked
          ? 'AI_ENDPOINT_BLOCKED'
          : err.code === 'invalid_key'
            ? 'AI_INVALID_CREDENTIALS'
            : err.code === 'rate_limited'
              ? 'AI_RATE_LIMITED'
              : err.code === 'timeout'
                ? 'AI_CONNECTION_TIMEOUT'
                : err.code === 'network_error'
                  ? 'AI_PROVIDER_UNAVAILABLE'
                  : 'AI_PROVIDER_MALFORMED_RESPONSE'
        return NextResponse.json(
          {
            error: {
              code,
              message: blocked
                ? 'The endpoint address is not permitted by the outbound security policy (HTTPS public addresses only, unless the deployment allowlists it).'
                : 'The selected model could not be verified on this connection.',
              retryable: code === 'AI_RATE_LIMITED' || code === 'AI_CONNECTION_TIMEOUT',
            },
          },
          { status: code === 'AI_INVALID_CREDENTIALS' ? 400 : blocked ? 403 : 502 },
        )
      }
      throw err
    }

    // Success: record the verification (does not touch the catalog).
    await supabase
      .from('ai_provider_connections')
      .update({ status: 'verified', verified_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)

    // Only safe metadata returns — never the probe's generated text.
    return NextResponse.json({
      ok: true,
      capability: 'chat',
      model,
      usage_reported: !!result.usage,
      verified_at: new Date().toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
