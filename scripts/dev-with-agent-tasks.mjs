import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import nextEnv from '@next/env'
import { developmentPort, shouldRunDevTaskWorker, shouldRunDevBroadcastWorker, shouldRunDevOpenWADeferredWorker } from './dev-agent-task-config.mjs'

const { loadEnvConfig } = nextEnv

// This file is executed by Node, NOT bundled into Next.js instrumentation.
// The actual Task handlers live inside the existing server API and reuse all
// durable SQL claims, provider policy and reconciliation gates.
loadEnvConfig(process.cwd(), true)
const args = process.argv.slice(2)
const port = developmentPort(args)
const enabled = shouldRunDevTaskWorker({
  nodeEnv: 'development',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  mode: process.env.WACRM_DEV_AGENT_TASK_WORKER,
})
const broadcastEnabled = shouldRunDevBroadcastWorker({
  nodeEnv: 'development',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  mode: process.env.WACRM_DEV_BROADCAST_WORKER,
})
const openwaDeferredEnabled = shouldRunDevOpenWADeferredWorker({
  nodeEnv: 'development',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  mode: process.env.WACRM_DEV_OPENWA_DEFERRED_WORKER,
})
const pollingEnabled = enabled || broadcastEnabled || openwaDeferredEnabled
const cronSecret = pollingEnabled
  ? (process.env.CRON_SECRET || randomBytes(32).toString('hex'))
  : process.env.CRON_SECRET
// Always pass an explicit port. Otherwise Next can silently pick 3001
// when 3000 is occupied, leaving the private worker polling the wrong site.
const hasPortArg = args.some(value => value === '-p' || value === '--port' ||
  value.startsWith('--port='))
const nextArgs = ['dev', ...args, ...(hasPortArg ? [] : ['-p', String(port)])]
const next = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', ...nextArgs],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      WACRM_DEV_AGENT_TASK_WORKER_ACTIVE: enabled ? '1' : '0',
      ...(cronSecret ? { CRON_SECRET: cronSecret } : {}),
    },
    windowsHide: true,
  },
)

let stopped = false
let polling = false
let timer
let firstTimeout
let failCount = 0
let lastGatedCount = 0
let repeatedGatedTicks = 0
async function tick() {
  if (!pollingEnabled || stopped || polling || next.exitCode !== null) return
  polling = true
  try {
    if (enabled) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/internal/ai-agent-task-worker', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cronSecret },
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Agent task worker endpoint HTTP ' + response.status)
      const data = await response.json()
      const activity = (data.tasks?.claimedTasks ?? 0) +
        (data.outbound?.attempted ?? 0) + (data.triggers?.completed ?? 0)
      const gated = data.outbound?.gated ?? 0
      repeatedGatedTicks = gated > 0 && gated === lastGatedCount
        ? repeatedGatedTicks + 1 : 0
      const reportGate = gated > 0 &&
        (gated !== lastGatedCount || repeatedGatedTicks % 20 === 0)
      lastGatedCount = gated
      if (activity || data.tasks?.failed || data.outbound?.reconciliation || reportGate) {
        console.info('[TEST Agent Task worker] tick', {
          claims: data.tasks?.claimedTasks ?? 0,
          runs: data.tasks?.createdRuns ?? 0,
          attempted: data.outbound?.attempted ?? 0,
          sent: data.outbound?.sent ?? 0, gated,
          reconciliation: data.outbound?.reconciliation ?? 0,
        })
      }
    }
    if (broadcastEnabled) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/internal/whatsapp-broadcast-worker', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cronSecret },
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Broadcast worker endpoint HTTP ' + response.status)
      const data = await response.json()
      if (data.claimed || data.paused) {
        console.info('[TEST Broadcast worker]', data)
      }
    }
    if (openwaDeferredEnabled) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/internal/openwa-deferred-worker', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cronSecret },
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('OpenWA deferred worker endpoint HTTP ' + response.status)
      const result = await response.json()
      if (result.claimed) {
        console.info('[TEST OpenWA deferred worker] tick', result)
      }
    }
    failCount = 0
  } catch (error) {
    // NEXT might still be booting; retry without starting a second tick.
    failCount += 1
    if (failCount === 1 || failCount % 10 === 0) {
      console.warn('[TEST Agent Task worker] tick could not complete:',
        error instanceof Error ? error.message : String(error))
    }
  } finally {
    polling = false
  }
}
function shutdown(signal) {
  if (stopped) return
  stopped = true
  if (timer) clearInterval(timer)
  if (firstTimeout) clearTimeout(firstTimeout)
  if (next.exitCode === null) next.kill(signal)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
next.on('error', error => {
  console.error('[WACRM] could not start Next.js:', error)
  shutdown('SIGTERM')
  process.exitCode = 1
})
next.on('exit', (code, signal) => {
  shutdown('SIGTERM')
  process.exit(code ?? (signal ? 1 : 0))
})
if (pollingEnabled) {
  console.info('[WACRM TEST] Automatic workers enabled:', {
    agentTasks: enabled, broadcastDelivery: broadcastEnabled, openwaDeferred: openwaDeferredEnabled,
    cadenceSeconds: 15,
    notice: 'This can send queued WhatsApp messages on TEST only',
  })
  firstTimeout = setTimeout(() => { void tick() }, 8_000)
  timer = setInterval(() => { void tick() }, 15_000)
} else {
  console.info('[WACRM] Automatic WhatsApp workers inactive (non-TEST or explicit opt-out).')
}
