import { describe, expect, it } from 'vitest'
import {
  deriveOpenWASupportSnapshot, formatOpenWASupportHandoff,
  type SupportSource,
} from './support-diagnostics'

const SECRET = 'MY-REAL-GATEWAY-API-KEY-PRIVATE'
const PHONE = '967700111222'
const URL = 'https://secret-openwa.example.test/hidden-key'
const ACCOUNT = '88888888-8888-4888-8888-888888888888'
const EVENT = '77777777-7777-4777-8777-777777777777'
const unsafe = {
  provider: 'openwa', production_send_authorized: false, operational_gate: 'enforce_release',
  deployment_release_enabled: false,
  policy: { approved: false, version: 'policy-secret', digest: 'a'.repeat(64),
    terms: {ar: 'TEXTSECRET',en:'TEXTSECRET'} },
  consent: { status: 'revoked', current: false, accepted_event_id: EVENT,
    actor_id: ACCOUNT, policy_version: 'PRIVATE_POLICY' },
  connections: [
    { connection_id: ACCOUNT, display_name: 'Patient ' + PHONE, phone_identity: PHONE,
      gateway_base_url: URL, session_id: 'PRIVATE_SESSION_ID',
      session_ready: false, requested_activation: 'disabled', reason: 'consent_required' },
    { connection_id: 'b', display_name: SECRET, session_ready: true,
      requested_activation: 'enabled', reason: 'request_admission_required' },
  ],
  audit: {consent:[{ actor_id: ACCOUNT, raw_text: 'TEXTSECRET' }], activation:[]},
}
const rawConnections = {
  connections: [
    { id: ACCOUNT, display_name: PHONE, session_id: SECRET, gateway_base_url: URL,
      guardrail: { manual_paused: true },
      outbound_review: { unreviewed_count: 2, reviewed_uncertain_count: 100 } },
    { id: 'b', display_name: SECRET, session_id: EVENT,
      guardrail: { manual_paused: false },
      outbound_review: { unreviewed_count: 3, reviewed_uncertain_count: 0 } },
  ],
}
const ok = (data: unknown): SupportSource => ({status:'ok',data})

describe('W07-06 support diagnostic privacy and truthfulness', () => {
  it('copies only allowlisted aggregate evidence, no secrets, identities, URLs or raw errors', () => {
    const s = deriveOpenWASupportSnapshot(ok(unsafe),ok(rawConnections))
    expect(s).toMatchObject({
      version:'w07-support-v1',
      operationalRead:'ok',sessionsRead:'ok',gateMode:'enforce_release',
      policyApproved:false,consentStatus:'revoked',consentCurrent:false,
      releaseConfigured:false,connectionCount:2,readyCount:1,
      enabledRequestedCount:1,pausedCount:1,uncertainCount:5,
      countsConsistent:true,
    })
    expect(s.blockingReasonCounts.consent_required).toBe(1)
    expect(s.blockingReasonCounts.request_admission_required).toBe(1)
    const report = formatOpenWASupportHandoff(s,new Date('2026-11-20T12:00:00.000Z'),'ar-YE')
    for (const sensitive of [SECRET, PHONE, URL, ACCOUNT, EVENT,'TEXTSECRET','PRIVATE_POLICY','PRIVATE_SESSION_ID']) {
      expect(report).not.toContain(sensitive)
      expect(JSON.stringify(s)).not.toContain(sensitive)
    }
    expect(report).toContain('operational_read=ok')
    expect(report).toContain('reason_consent_required=1')
    expect(report).toContain('outbound_unreviewed_count=5')
    expect(report).toContain('2026-11-20T12:00:00.000Z')
    expect(report).not.toContain('send_authorized=true')
  })
  it('fails safely for unavailable, forbidden or invalid payloads, never inventing healthy zeros', () => {
    const missing = deriveOpenWASupportSnapshot({status:'unavailable'},{status:'forbidden'})
    expect(missing.operationalRead).toBe('unavailable')
    expect(missing.sessionsRead).toBe('forbidden')
    expect(missing.connectionCount).toBeNull()
    expect(missing.pausedCount).toBeNull()
    expect(missing.uncertainCount).toBeNull()
    expect(missing.policyApproved).toBeNull()
    expect(missing.releaseConfigured).toBeNull()
    expect(missing.suggestedProcedures).toContain('test-schema-unavailable')
    const malformed = deriveOpenWASupportSnapshot(ok({connections:[],production_send_authorized:true}),
      ok({connections:[{random:'x'},'not-object']}))
    expect(malformed.operationalRead).toBe('invalid')
    expect(malformed.sessionsRead).toBe('invalid')
    expect(malformed.readyCount).toBeNull()
    expect(malformed.connectionCount).toBeNull()
  })
  it('detects mismatched results and refuses forged reason strings or invalid review counts', () => {
    const policy = {...unsafe, connections: [
      {...unsafe.connections[0], reason: 'send_allowed_secret_' + SECRET},
    ]}
    const sessions = {connections:[{...rawConnections.connections[0],
      outbound_review:{unreviewed_count:-3}},
      rawConnections.connections[1]]}
    const s = deriveOpenWASupportSnapshot(ok(policy),ok(sessions))
    expect(s.connectionCount).toBe(1)
    expect(s.countsConsistent).toBe(false)
    expect(s.uncertainCount).toBeNull()
    expect(s.blockingReasonCounts.unknown).toBe(1)
    expect(formatOpenWASupportHandoff(s,new Date('bad'),'en'))
      .not.toContain(SECRET)
  })
  it('never equates TEST Pilot or a ready session with production send permission', () => {
    const test = deriveOpenWASupportSnapshot(ok({
      ...unsafe, operational_gate:'legacy_test',
      deployment_release_enabled: true,
      policy:{approved:true}, consent:{status:'accepted',current:true},
      connections:[{session_ready:true,requested_activation:'enabled',
        reason:'request_admission_required'}],
    }),ok({connections:[{guardrail:{manual_paused:false},
      outbound_review:{unreviewed_count:0}}]}))
    expect(test.gateMode).toBe('legacy_test')
    expect(test.releaseConfigured).toBeNull()
    expect(formatOpenWASupportHandoff(test,new Date('2026-11-20'),'en'))
      .toContain('release_configured=unknown')
  })
})
