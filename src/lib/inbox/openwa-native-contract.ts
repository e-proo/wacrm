import type { OpenWAClient, OpenWASessionStatus } from '@/lib/whatsapp/transport/openwa/client'

// Exact source-reviewed contract, not a permissive semver range. OpenWA
// v0.29.1: auth-validate.controller, health.controller, session-response.dto,
// message-mapper/buildIncomingMessageBase and readWid. Baileys supplies a
// different, chat-sensitive key and cannot yet share this canonical contract.
export const OPENWA_NATIVE_CONTRACT = { engine: 'whatsapp-web.js', version: '0.29.1', scope: 'single_connection' } as const
// v0.32.1 reviewed at upstream commit 0bf6740b7c51f29a2389739e9cc7a8da0cfd0b2b.
// Deployment-level engine metadata requires the operator to verify a single
// node or homogeneous gateway deployment during live acceptance.
export const OPENWA_NATIVE_VERSIONS=['0.29.1','0.32.1'] as const
export type ReviewedOpenWAVersion=typeof OPENWA_NATIVE_VERSIONS[number]
export type OpenWANativeContract={engine:typeof OPENWA_NATIVE_CONTRACT.engine;version:ReviewedOpenWAVersion;scope:typeof OPENWA_NATIVE_CONTRACT.scope}
export function isReviewedOpenWAVersion(value:unknown):value is ReviewedOpenWAVersion{
 return typeof value==='string'&&(OPENWA_NATIVE_VERSIONS as readonly string[]).includes(value)
}
export type NamespaceEnrollmentCode = 'namespace_engine_unverified' | 'namespace_version_unsupported' | 'namespace_engine_unsupported' | 'namespace_session_not_live' | 'namespace_webhook_unconfigured' | 'namespace_handover_requires_proof' | 'namespace_enrollment_failed'
export class InboxNamespaceEnrollmentError extends Error {
  constructor(public readonly code: NamespaceEnrollmentCode) { super(code); this.name = 'InboxNamespaceEnrollmentError' }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function parseOpenWANativeContract(auth: unknown, health: unknown, status: OpenWASessionStatus) {
  const a = object(auth), h = object(health)
  if (status.raw?.engineLoaded !== true) throw new InboxNamespaceEnrollmentError('namespace_session_not_live')
  if (a?.valid !== true || typeof a.engineType !== 'string') throw new InboxNamespaceEnrollmentError('namespace_engine_unverified')
  if (a.engineType !== OPENWA_NATIVE_CONTRACT.engine) throw new InboxNamespaceEnrollmentError('namespace_engine_unsupported')
  if (h?.status !== 'ok' || !isReviewedOpenWAVersion(h.version)) throw new InboxNamespaceEnrollmentError('namespace_version_unsupported')
  return {...OPENWA_NATIVE_CONTRACT,version:h.version} satisfies OpenWANativeContract
}
export async function verifyOpenWANativeContract(client: OpenWAClient, status: OpenWASessionStatus, connectionId: string) {
  // Both probes use the existing configured, authenticated server-only client.
  // auth/validate is a documented read-only POST, no key creation or session mutation.
  let auth: unknown, health: unknown
  try {
    [auth, health] = await Promise.all([
      client.request<unknown>('/api/auth/validate', { method: 'POST', correlationId: connectionId }),
      client.request<unknown>('/api/health', { correlationId: connectionId }),
    ])
  } catch {
    throw new InboxNamespaceEnrollmentError('namespace_engine_unverified')
  }
  return parseOpenWANativeContract(auth, health, status)
}
