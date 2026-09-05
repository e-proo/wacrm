import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  listAvailablePresets,
} from '@/lib/ai/providers/presets'

/**
 * GET /api/ai/provider-presets
 *
 * Safe server-defined preset metadata for the connection form: id,
 * label, protocol, defaultApiRoot, apiRootMode, availability. No
 * secrets, no catalog contents. The client renders fixed roots as
 * read-only and only offers custom root inputs for deployment-enabled
 * presets (§9 of the docs: the client can NEVER shape a fixed root —
 * the POST route re-validates anyway; this list is display sugar).
 */
export async function GET() {
  try {
    await requireRole('viewer') // any account member
    const presets = listAvailablePresets({
      customEndpointsEnabled: process.env.AI_CUSTOM_ENDPOINTS_ENABLED === 'true',
      privateEndpointsEnabled: process.env.AI_PRIVATE_ENDPOINTS_ENABLED === 'true',
    }).map((p) => ({
      id: p.id,
      label: p.label,
      protocol: p.protocol,
      defaultApiRoot: p.defaultApiRoot,
      api_root_mode: p.apiRootMode,
      availability: p.availability,
    }))
    return NextResponse.json({ presets })
  } catch (err) {
    return toErrorResponse(err)
  }
}
