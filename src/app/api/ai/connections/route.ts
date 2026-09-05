import { NextResponse } from 'next/server'
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ConnectionService } from '@/lib/ai/connections/service'
import { listSafeConnections } from '@/lib/ai/connections/loader'
import { resolvePreset } from '@/lib/ai/providers/presets'

// Phase 02: connection CRUD is behind the feature flag. When off,
// the old POST /api/ai/config path keeps working; these routes 308
// to a "not available" message so callers get an accurate gate.
const FEATURE_FLAG_ENV = 'AI_MULTI_PROVIDER_ENABLED'

function flagEnabled(): boolean {
  return process.env[FEATURE_FLAG_ENV] === 'true'
}

function disabledResponse() {
  return NextResponse.json(
    { error: 'Multi-provider connections are not enabled on this deployment.' },
    { status: 404 },
  )
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/connections
 * member+ : safe metadata only (no keys, no ciphertext, no
 * fingerprint). `catalogStale` is derived server-side.
 */
export async function GET() {
  try {
    if (!flagEnabled()) return disabledResponse()
    const { supabase, accountId } = await getCurrentAccount()
    const connections = await listSafeConnections(supabase, accountId)
    return NextResponse.json({ connections })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/connections  (admin+)
 * Create a new provider connection. The API key is encrypted via the
 * shared AES-256-GCM helper and never stored or returned as plaintext.
 */
export async function POST(request: Request) {
  try {
    if (!flagEnabled()) return disabledResponse()
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-conn:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 100) {
      return bad('name is required (max 100 chars)')
    }

    const presetId = typeof body.preset_id === 'string' ? body.preset_id.trim() : ''
        const preset = resolvePreset(presetId, {
        customEndpointsEnabled: process.env.AI_CUSTOM_ENDPOINTS_ENABLED === 'true',
        privateEndpointsEnabled: process.env.AI_PRIVATE_ENDPOINTS_ENABLED === 'true',
        })
        if (!preset) {
          return bad(
            'Unknown preset' +
              (presetId.includes('custom')
                ? ' — custom endpoints are not enabled for this deployment'
                : ''),
          )
        }

    // fixed-root presets reject a client-supplied root with 400 (never
    // silently ignore — security wants an explicit failure).
    if (preset.apiRootMode === 'fixed' && body.api_root != null && body.api_root !== '') {
      return bad(`Connection preset '${preset.id}' is fixed-root`)
    }

    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!apiKey) return bad('api_key is required for new connections')

    const service = new ConnectionService({ accountId, userId })
    let payload: ReturnType<ConnectionService['buildCreate']>
    try {
      payload = service.buildCreate({
        name,
        presetId: preset.id,
        apiRoot: body.api_root ?? null,
        apiKey,
      })
    } catch (err) {
      return bad(err instanceof Error ? err.message : 'Invalid connection input')
    }

    const { error: insErr } = await supabase
      .from('ai_provider_connections')
      .insert({
        account_id: accountId,
        created_by: userId,
        ...payload,
        status: 'unverified',
      })
    if (insErr) {
      // Duplicate name within the account → friendly 409.
      if (insErr.code === '23505') {
        return NextResponse.json({ error: 'A connection with that name already exists' }, { status: 409 })
      }
      console.error('[ai/connections POST] insert error:', insErr)
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
    }

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
