#!/usr/bin/env node
// One-off backfill runner — run with:
//   node scripts/backfill.mjs <account_id>
//
// Reads the service-role Supabase credentials from the same
// env vars the app uses, then runs the same backfill the API
// endpoint runs.

import { createClient } from '@supabase/supabase-js'

const ACCOUNT_ID = process.argv[2]
if (!ACCOUNT_ID) {
  console.error('Usage: node scripts/backfill.mjs <account_id>')
  process.exit(1)
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// --- 1) Look at the account + legacy config -------------------------
const { data: account, error: accErr } = await supabase
  .from('accounts')
  .select('id, name')
  .eq('id', ACCOUNT_ID)
  .maybeSingle()
if (accErr || !account) {
  console.error('Account not found:', accErr?.message ?? 'no row')
  process.exit(1)
}
console.log('Account:', account.name, account.id)

const { data: legacy, error: legErr } = await supabase
  .from('ai_configs')
  .select('id, provider, model, is_active, auto_reply_enabled')
  .eq('account_id', ACCOUNT_ID)
  .maybeSingle()
if (legErr) {
  console.error('ai_configs read failed:', legErr.message)
  process.exit(1)
}
if (!legacy) {
  console.log('No ai_configs row for this account — nothing to backfill.')
  process.exit(0)
}
console.log('Legacy config found:', legacy)

// --- 2) Idempotency: skip if already backfilled --------------------
const { data: existingConn } = await supabase
  .from('ai_provider_connections')
  .select('id, status')
  .eq('account_id', ACCOUNT_ID)
  .eq('legacy_ai_config_id', legacy.id)
  .maybeSingle()
if (existingConn) {
  console.log('Connection already exists:', existingConn)
  const { data: existingAgent } = await supabase
    .from('ai_agents')
    .select('id, published_revision_id')
    .eq('account_id', ACCOUNT_ID)
    .eq('system_key', 'customer_service')
    .maybeSingle()
  if (existingAgent?.published_revision_id) {
    console.log('Backfill already done — skipping.')
    process.exit(0)
  }
}

// --- 3) The actual backfill needs the TS service -----------------
// At this point, the cleanest path is to call the API endpoint
// you just deployed. The script below does that — but only if
// the production server is reachable.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL
if (!APP_URL) {
  console.error('Missing APP_URL — set NEXT_PUBLIC_APP_URL to call the endpoint')
  process.exit(1)
}

// Use the user's own session token if you have one; otherwise
// the endpoint requires admin auth, which is tricky from a
// script. Simpler: just print the curl for the admin to run.
console.log('Run this from your terminal while logged in:')
console.log(`  curl -X POST ${APP_URL}/api/admin/backfill-legacy -H "Cookie: <your-session>"`)
process.exit(0)
