import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { loadEnvConfig } from '@next/env'
import { developmentPort, shouldRunDevTaskWorker } from './dev-agent-task-config.mjs'

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
const cronSecret = enabled
  ? (process.env.CRON_SECRET || randomBytes(32).toString('hex'))
  : process.env.CRON_SECRET
const nextArgs = ['dev', ...(args.length ? args : ['-p', String(port)])]
const next = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', ...nextArgs],
  {
    stdio: 'inherit',
    env: { ...process.env, ...(cronSecret ? { CRON_SECRET: cronSecret } : {}) },
    windowsHide: true,
  },
)

let stopped = false
let polling = false
let timer
let firstTimeout
let failCount = 0
async function tick() {
  if (!enabled || stopped || polling || next.exitCode !== null) return
  polling = true
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/internal/ai-agent-task-worker`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(120_000),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Worker endpoint HTTP ${response.status}`)
    const data = await response.json()
    failCount = 0
    const activity = (data.tasks?.claimedTasks ?? 0) +
      (data.outbound?.attempted ?? 0) + (data.triggers?.completed ?? 0)
    if (activity || data.tasks?.failed || data.outbound?.reconciliation) {
      console.info('[TEST Agent Task worker] tick', {
        claims: data.tasks?.claimedTasks ?? 0,
        targets: data.tasks?.materializedTargets ?? 0,
        runs: data.tasks?.createdRuns ?? 0,
        sent: data.outbound?.sent ?? 0,
        gated: data.outbound?.gated ?? 0,
        reconciliation: data.outbound?.reconciliation ?? 0,
        errors: data.tasks?.failed ?? 0,
      })
    }
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
if (enabled) {
  console.info('[WACRM TEST] Agent Tasks auto-run every 15 seconds while npm run dev is active.' +
    ' This can send previously approved WhatsApp messages. ' +
    'Disable with WACRM_DEV_AGENT_TASK_WORKER=off in .env.local, then restart.')
  firstTimeout = setTimeout(() => { void tick() }, 8_000)
  timer = setInterval(() => { void tick() }, 15_000)
} else {
  console.info('[WACRM] Automatic Agent Task worker inactive (non-TEST or explicit opt-out).')
}
