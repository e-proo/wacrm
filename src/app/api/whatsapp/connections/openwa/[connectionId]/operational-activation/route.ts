import { NextResponse } from 'next/server'

import { ForbiddenError, UnauthorizedError, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  OPENWA_CONTROL_NO_STORE, canWriteOpenWAControl, isOpenWAControlSameOrigin,
  isOpenWAControlUuid, mapOpenWAControlOutcome, parseOpenWAActivationMutation,
  readOpenWAControlJson,
} from '@/lib/whatsapp/transport/openwa/operational-control-api'

export const runtime = 'nodejs'
const noStore = OPENWA_CONTROL_NO_STORE
type Context = { params: Promise<{ connectionId: string }> }

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore })
}

function errorResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return reply({ code: 'unauthorized', error: 'Authentication required' }, 401)
  }
  if (error instanceof ForbiddenError) {
    return reply({ code: 'forbidden', error: 'Admin permission required' }, 403)
  }
  return reply({ code: 'control_unavailable', error: 'OpenWA activation control is unavailable' }, 503)
}


/**
 * Store a requested status for this tenant's single OpenWA connection.
 * Neither this route nor the SQL RPC can send messages, create sessions,
 * change Pilot, or override Meta/default routing.
 *
 * "enable" is intentionally blocked by default until W07-04's shared
 * send-time admission control is verified; "disable"/"suspend" remain
 * available to authorized operators for safe containment.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const { connectionId } = await context.params
    if (!isOpenWAControlUuid(connectionId)) {
      return reply({ code: 'invalid_connection', error: 'Invalid connection identifier' }, 400)
    }
    if (!isOpenWAControlSameOrigin(request)) {
      return reply({ code: 'invalid_origin', error: 'Same-origin JSON request required' }, 403)
    }
    const parsed = parseOpenWAActivationMutation(await readOpenWAControlJson(request))
    if (!parsed.ok) return reply({ code: parsed.code, error: 'Invalid activation action' }, 400)
    const input = parsed.value
    if (!canWriteOpenWAControl(input.action)) {
      return reply({ code: 'control_stage_not_ready', error: 'OpenWA activation is not available yet' }, 409)
    }
    const status = input.action === 'enable' ? 'enabled'
      : input.action === 'disable' ? 'disabled' : 'suspended'
    const { data, error } = await supabaseAdmin().rpc('set_openwa_operational_activation', {
      p_account_id: accountId,
      p_connection_id: connectionId,
      p_actor: userId,
      p_status: status,
      p_expected_revision: input.expected_revision,
      p_request_id: input.request_id,
    })
    if (error) return reply({ code: 'control_unavailable', error: 'Connection status could not be verified' }, 503)
    const mapped = mapOpenWAControlOutcome(data)
    return reply(mapped.body, mapped.status)
  } catch (error) {
    return errorResponse(error)
  }
}
