/**
 * An automatically scheduled worker is safe only in the pinned Supabase TEST
 * project and in a long-lived local Node.js development server.
 *
 * In production/serverless, operators must configure a real external cron
 * invoking the existing protected /api/internal/ai-agent-worker endpoint.
 * No background sends are ever started in an unrecognized environment.
 */
export const TEST_SUPABASE_URL = 'https://pqirsnfupofhulmewakq.supabase.co'

export interface DevTaskWorkerEnvironment {
  nodeEnv?: string
  nextRuntime?: string
  supabaseUrl?: string
  mode?: string
}

export function shouldStartDevAgentTaskWorker(input: DevTaskWorkerEnvironment): boolean {
  if (input.nodeEnv !== 'development' || input.nextRuntime !== 'nodejs') return false
  if (input.supabaseUrl !== TEST_SUPABASE_URL) return false
  // No opt-in is needed per Task: a pinned TEST dev server starts the worker
  // by default. Explicit opt-out is always available in .env.local.
  const mode = input.mode ?? 'on'
  return mode === 'on'
}
