import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ConnectionService } from '@/lib/ai/connections/service'
import type { ConnectionRow } from '@/lib/ai/connections/types'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const FEATURE_FLAG_ENV = process.env.AI_MULTI_PROVIDER_ENABLED === 'true'

function disabledResponse() {
  return NextResponse.json(
    { error: 'Multi-provider connections are not enabled on this deployment.' },
    { status: 404 },
  )
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

type Params = { params: Promise<{ id: string }> }
const CONN_COLUMNS =
  'id, account_id, name, preset_id, protocol, api_root, encrypted_api_key, connection_fingerprint'

export async function PATCH(request: Request, { params }: Params) {
  try {
    if (!FEATURE_FLAG_ENV) return disabledResponse()
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`ai-conn:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    // Load the existing row (RLS-scoped) so we preserve the untouched
    // key and the fixed preset root.
    const { data: existing, error: loadErr } = await supabase
      .from('ai_provider_connections')
      .select(CONN_COLUMNS)
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (loadErr) {
      console.error('[ai/connections PATCH] load error:', loadErr)
      return NextResponse.json({ error: 'Failed to load connection' }, { status: 500 })
    }
    if (!existing) return NextResponse.json({ error: 'Connection not found' }, { status: 404 })

    const row = existing as ConnectionRow

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const patch: Record<string, unknown> = {}
    if ('name' in body) {
      const n = typeof body.name === 'string' ? body.name.trim() : ''
      if (!n || n.length > 100) return bad('name must be 1-100 chars')
      patch.name = n
    }

    if ('api_root' in body) {
      const root = body.api_root === null ? null : typeof body.api_root === 'string' ? body.api_root.trim() : null
      if (root !== null && root !== '' && root.length > 512) {
        return bad('api_root too long')
      }
      try {
        const svc = new ConnectionService({ accountId, userId })
        Object.assign(patch, svc.buildUpdate(row, { apiRoot: root }))
      } catch (err) {
        return bad(err instanceof Error ? err.message : 'Invalid api_root')
      }
    }

    if ('api_key' in body) {
      const svc = new ConnectionService({ accountId, userId })
      try {
        // buildUpdate throws on `null` api_key (clearing is a separate
        // action), so a PATCH that omits api_key is a no-op on the key.
        Object.assign(patch, svc.buildUpdate(row, { apiKey: body.api_key as never }))
      } catch (err) {
        return bad(err instanceof Error ? err.message : 'Invalid api_key')
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const { error: upErr } = await supabase
      .from('ai_provider_connections')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/connections PATCH] update error:', upErr)
      return NextResponse.json({ error: 'Failed to update connection' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    if (!FEATURE_FLAG_ENV) return disabledResponse()
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params

    const limit = checkRateLimit(`ai-conn:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    // FR-CON-07: refuse deletion if the connection is referenced by a
    // config row (chat OR embedding). The service-role client bypasses
    // RLS, so scope by account_id explicitly and validate the UUID
    // before interpolating it into the `.or()` filter string.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return bad('Invalid connection id')
    }
    const admin = supabaseAdmin()
    const { data: refs, error: refErr } = await admin
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .or(`chat_connection_id.eq.${id},embedding_connection_id.eq.${id}`)
      .limit(1)
    if (refErr) {
      console.error('[ai/connections DELETE] reference check error:', refErr)
      return NextResponse.json({ error: 'Failed to delete connection' }, { status: 500 })
    }
    if (refs && refs.length > 0) {
      return NextResponse.json(
        {
          error:
            'This connection is in use by an assistant configuration. Unlink it from your settings first.',
        },
        { status: 409 },
      )
    }

    const { error: delErr } = await supabase
      .from('ai_provider_connections')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (delErr) {
      console.error('[ai/connections DELETE] error:', delErr)
      return NextResponse.json({ error: 'Failed to delete connection' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
