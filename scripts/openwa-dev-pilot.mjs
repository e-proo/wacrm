#!/usr/bin/env node
/**
 * OW-13 DEV-only, single-connection pilot operator utility.
 *
 * Usage (Node 22+, from WACRM repository root, PowerShell):
 *   node --env-file=.env.local scripts/openwa-dev-pilot.mjs status
 *   node --env-file=.env.local scripts/openwa-dev-pilot.mjs grant --approver=USER_UUID --consent-confirmed --ack-duplicate-sessions
 *   node --env-file=.env.local scripts/openwa-dev-pilot.mjs stop --confirm-stop
 *
 * No outbound WhatsApp send is issued by this utility. The recipient is read
 * interactively and stored only as a scoped SHA-256 hash. This script never
 * prints a recipient, API token, webhook secret or the recipient hash.
 */
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { createClient } from '@supabase/supabase-js'

const TEST_REF = 'pqirsnfupofhulmewakq'
const ACCOUNT_ID = '8ed95309-96cd-4347-b725-bd8c5039ed4f'
const CONNECTION_ID = '2dacee52-3486-4b47-96a0-fa4399ac0fb2'
const MAX_ACTIVE_HOURS = 4
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const [action = 'status', ...flags] = process.argv.slice(2)
const has = (name) => flags.includes(name)
const option = (prefix) => flags.find((s) => s.startsWith(prefix))?.slice(prefix.length)

function expect(value, message) {
  if (!value) throw new Error(message)
}

function dataOrError(result, label) {
  if (result.error) throw new Error(`${label} failed (code=${/^[A-Za-z0-9_]{1,20}$/.test(result.error.code ?? '') ? result.error.code : 'unknown'})`)
  return result.data
}

function canonicalRecipient(value) {
  const trimmed = value.trim()
  if (/^[1-9][0-9]{6,14}$/.test(trimmed)) return `${trimmed}@c.us`
  if (/^[0-9]{5,20}@(c\.us|lid)$/.test(trimmed)) return trimmed
  return null
}

async function main() {
  expect(['status', 'grant', 'stop'].includes(action), 'Expected status, grant or stop')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  expect(url && key, 'Missing TEST Supabase URL or server-only service role key')
  let endpoint
  try { endpoint = new URL(url) } catch { throw new Error('Invalid Supabase URL') }
  expect(endpoint.protocol === 'https:' && endpoint.hostname === `${TEST_REF}.supabase.co`,
    'Refusing to run: .env.local does not point to the pinned WACRM TEST project')

  const db = createClient(endpoint.toString(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const conn = dataOrError(await db.from('whatsapp_connections')
    .select('id,account_id,status,session_id,phone_identity,archived_at')
    .eq('id', CONNECTION_ID).eq('account_id', ACCOUNT_ID).eq('provider', 'openwa')
    .maybeSingle(), 'Connection lookup')
  expect(conn && !conn.archived_at && conn.session_id, 'Pilot connection is absent, archived or lacks a session')

  const guard = dataOrError(await db.from('whatsapp_connection_guardrails')
    .select('manual_paused,hourly_cap,daily_cap,first_touch_daily_cap,minimum_interval_ms')
    .eq('connection_id', CONNECTION_ID).eq('account_id', ACCOUNT_ID)
    .maybeSingle(), 'Guardrail lookup')

  const unsettled = await db.from('messages').select('id', { head: true, count: 'exact' })
    .eq('provider', 'openwa').eq('connection_id', CONNECTION_ID)
    .eq('status', 'sending').is('provider_message_id', null)
  dataOrError(unsettled, 'Unsettled message lookup')

  const active = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id', { head: true, count: 'exact' })
    .eq('account_id', ACCOUNT_ID).eq('connection_id', CONNECTION_ID).eq('active', true)
  dataOrError(active, 'Active pilot admission lookup')

  const duplicates = conn.phone_identity
    ? await db.from('whatsapp_connections').select('id', { head: true, count: 'exact' })
      .eq('account_id', ACCOUNT_ID).eq('provider', 'openwa')
      .eq('phone_identity', conn.phone_identity)
      .in('status', ['ready', 'connected']).is('archived_at', null)
    : { count: 0, error: null }
  dataOrError(duplicates, 'Duplicate session lookup')

  const state = {
    environment: 'TEST ONLY',
    connection: CONNECTION_ID,
    status: conn.status,
    paused: guard?.manual_paused ?? null,
    hourly_cap: guard?.hourly_cap ?? null,
    daily_cap: guard?.daily_cap ?? null,
    first_touch_daily_cap: guard?.first_touch_daily_cap ?? null,
    unsettled_outbound: unsettled.count ?? null,
    active_admissions: active.count ?? null,
    same_identity_ready_connections: duplicates.count ?? null,
    local_env_pilot_mode: process.env.OPENWA_PILOT_MODE ?? 'off',
    runtime_mode_confirmed: false,
  }

  if (action === 'status') {
    console.log(JSON.stringify(state, null, 2))
    console.log('Runtime mode is NOT provable from this script. Restart WACRM after changing .env.local.')
    return
  }

  if (action === 'stop') {
    expect(has('--confirm-stop'), 'Explicit --confirm-stop required')
    dataOrError(await db.from('whatsapp_connection_guardrails')
      .update({ manual_paused: true, updated_at: new Date().toISOString() })
      .eq('account_id', ACCOUNT_ID).eq('connection_id', CONNECTION_ID), 'Emergency pause')
    dataOrError(await db.from('whatsapp_openwa_pilot_allowlist')
      .update({ active: false }).eq('account_id', ACCOUNT_ID)
      .eq('connection_id', CONNECTION_ID).eq('active', true), 'Pilot cohort revocation')
    dataOrError(await db.from('whatsapp_guardrail_events')
      .insert({ account_id: ACCOUNT_ID, connection_id: CONNECTION_ID,
        workload: 'manual', decision: 'paused', reason: 'ow13_dev_pilot_operator_stop' }),
    'Stop audit')
    console.log('TEST pilot paused and admission revoked for the pinned connection. In-flight sends may still complete.')
    return
  }

  // GRANT does not unpause the connection or dispatch a provider request.
  expect(process.env.OPENWA_PILOT_MODE === 'enforce',
    'Set OPENWA_PILOT_MODE=enforce in local WACRM .env.local and restart the dev server first')
  expect(has('--consent-confirmed'), 'Recipient consent must be explicitly confirmed')
  expect(has('--ack-duplicate-sessions') || (duplicates.count ?? 0) <= 1,
    'Multiple WACRM connections share the WhatsApp identity; reconcile them or explicitly acknowledge via --ack-duplicate-sessions')
  expect(conn.status === 'ready' || conn.status === 'connected', 'Pilot session not ready')
  expect(guard?.manual_paused === true, 'Connection must remain paused until the allowlist grant is ready')
  expect((guard.hourly_cap ?? Infinity) <= 3 && (guard.daily_cap ?? Infinity) <= 10
    && (guard.first_touch_daily_cap ?? Infinity) <= 1
    && (guard.minimum_interval_ms ?? 0) >= 15000,
  'Guardrail pilot limits are missing or insufficient')
  expect((unsettled.count ?? 0) === 0, 'Connection has unresolved OpenWA outbound messages')
  expect((active.count ?? 0) === 0, 'Existing active recipient approval must be revoked before granting another')

  const approver = option('--approver=')
  expect(approver && UUID.test(approver), 'Provide --approver=USER_UUID for the actual TEST owner/admin')
  const profile = dataOrError(await db.from('profiles')
    .select('user_id,account_role').eq('user_id', approver).eq('account_id', ACCOUNT_ID)
    .maybeSingle(), 'Approver lookup')
  expect(profile && ['owner', 'admin'].includes(profile.account_role),
    'Approver must be an actual TEST owner/admin for the target account')

  expect(process.stdin.isTTY, 'Enter the controlled recipient interactively in a terminal')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let input
  try { input = await rl.question('Controlled consenting test recipient (phone or @lid; not logged): ') }
  finally { rl.close() }
  const recipient = canonicalRecipient(input)
  expect(recipient, 'Unsupported recipient identity; must be canonical OpenWA JID or phone')
  const hash = createHash('sha256')
    .update(`openwa-pilot:v1:${ACCOUNT_ID}:${CONNECTION_ID}:${recipient}`)
    .digest('hex')

  const now = new Date()
  const expires = new Date(now.getTime() + MAX_ACTIVE_HOURS * 60 * 60 * 1000)
  dataOrError(await db.from('whatsapp_openwa_pilot_allowlist')
    .upsert({
      account_id: ACCOUNT_ID, connection_id: CONNECTION_ID,
      recipient_hash: hash, workload: 'manual',
      active: true, approved_by: approver,
      approved_at: now.toISOString(), expires_at: expires.toISOString(),
    }, { onConflict: 'account_id,connection_id,recipient_hash,workload' }), 'Pilot allowlist grant')

  console.log('One TEST-only, manual-send recipient approval stored as an opaque scoped hash.')
  console.log('The session remains PAUSED. Confirm WACRM has restarted in enforce mode, then resume ONLY this connection using the admin UI.')
  console.log('Send at most one controlled first-touch message, inspect replies/ACKs, and use the stop command immediately for any unexpected result.')
  console.log(`Approval expires at ${expires.toISOString()}; no recipient, JID or hash was printed.`)
}

main().catch((error) => {
  console.error(`OW-13 DEV pilot command stopped: ${error instanceof Error ? error.message : 'Unknown failure'}`)
  process.exitCode = 1
})
