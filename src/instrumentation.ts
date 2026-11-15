/**
 * Next.js invokes register once per server instance. Only a pinned TEST
 * development Node.js server may run the local Agent Task scheduler.
 * Production is intentionally left to the protected external cron route.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' ||
      process.env.NODE_ENV !== 'development') return
  const { startDevAgentTaskAutoWorker } = await import(
    './lib/ai/tasks/dev-auto-worker'
  )
  startDevAgentTaskAutoWorker()
}
