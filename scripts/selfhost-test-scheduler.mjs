/**
 * Optional pinned TEST-only self-hosted scheduler sidecar.
 * Calls existing authenticated WACRM handlers; never contacts WhatsApp directly.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const TEST_HOST = 'pqirsnfupofhulmewakq.supabase.co'
const APP_ORIGIN = 'http://app:3000'

export const JOBS = Object.freeze([
  { name: 'agent-task', path: '/api/internal/ai-agent-task-worker', method: 'POST', secret: 'CRON_SECRET', intervalMs: 15_000, initialDelayMs: 5_000 },
  { name: 'broadcast', path: '/api/internal/whatsapp-broadcast-worker', method: 'POST', secret: 'CRON_SECRET', intervalMs: 15_000, initialDelayMs: 10_000 },
  { name: 'openwa-deferred', path: '/api/internal/openwa-deferred-worker', method: 'POST', secret: 'CRON_SECRET', intervalMs: 15_000, initialDelayMs: 15_000 },
  { name: 'agent-recovery', path: '/api/internal/ai-agent-worker', method: 'POST', secret: 'CRON_SECRET', intervalMs: 60_000, initialDelayMs: 20_000 },
  { name: 'automations', path: '/api/automations/cron', method: 'GET', secret: 'AUTOMATION_CRON_SECRET', intervalMs: 60_000, initialDelayMs: 30_000 },
  { name: 'flows', path: '/api/flows/cron', method: 'GET', secret: 'AUTOMATION_CRON_SECRET', intervalMs: 300_000, initialDelayMs: 40_000 },
])

export function isPinnedTestProject(input) {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && url.hostname === TEST_HOST &&
      (url.port === '' || url.port === '443') && url.pathname === '/' &&
      !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export function validateEnvironment(env) {
  if (env.WACRM_TEST_WORKERS_ACK !== 'I_ACCEPT_TEST_WHATSAPP_SENDS') {
    throw new Error('Explicit TEST worker send acknowledgement is required')
  }
  if (!isPinnedTestProject(env.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new Error('Refusing scheduler: Supabase project is not the pinned TEST project')
  }
  for (const key of ['CRON_SECRET', 'AUTOMATION_CRON_SECRET']) {
    if (typeof env[key] !== 'string' || env[key].length < 32 || /^set-|^replace-|^your-/.test(env[key])) {
      throw new Error(key + ' must be a strong shared secret')
    }
  }
}

async function runJob(job, env, signal) {
  try {
    await sleep(job.initialDelayMs, undefined, { signal })
  } catch {
    return
  }
  while (!signal.aborted) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      const headers = job.secret === 'AUTOMATION_CRON_SECRET'
        ? { 'x-cron-secret': env.AUTOMATION_CRON_SECRET }
        : { Authorization: 'Bearer ' + env.CRON_SECRET }
      const response = await fetch(APP_ORIGIN + job.path, {
        method: job.method,
        headers: { ...headers, 'Cache-Control': 'no-store' },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      // Do not log response bodies or transport payloads.
      if (response.status !== 200 && response.status !== 202) {
        console.error('[selfhost-test] ' + job.name + ': HTTP ' + response.status)
      }
    } catch {
      if (!signal.aborted) console.error('[selfhost-test] ' + job.name + ': request failed (redacted)')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', stop)
    }
    try {
      await sleep(job.intervalMs, undefined, { signal })
    } catch {
      break
    }
  }
}

export async function main(env = process.env) {
  validateEnvironment(env)
  const shutdown = new AbortController()
  process.once('SIGTERM', () => shutdown.abort())
  process.once('SIGINT', () => shutdown.abort())
  console.info('[selfhost-test] TEST-only worker polling enabled; approved jobs may send messages')
  await Promise.all(JOBS.map(job => runJob(job, env, shutdown.signal)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('[selfhost-test] startup blocked: verify TEST target, acknowledgement and secrets')
    process.exitCode = 1
  })
}
