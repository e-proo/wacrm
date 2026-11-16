/** A local developer must never start a task scheduler on another project. */
export const DEV_TASK_TEST_URL = 'https://pqirsnfupofhulmewakq.supabase.co'

export function shouldRunDevTaskWorker({nodeEnv, supabaseUrl, mode}) {
  if (nodeEnv !== 'development') return false
  if (supabaseUrl !== DEV_TASK_TEST_URL) return false
  // Default ON only on the explicitly pinned TEST project.
  // Unknown values fail closed rather than weakening protection.
  return (mode ?? 'on') === 'on'
}

export function developmentPort(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const text = arg === '-p' || arg === '--port'
      ? args[index + 1] : arg.startsWith('--port=') ? arg.slice(7) : null
    if (text != null) {
      const port = Number(text)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid Next.js development port')
      }
      return port
    }
  }
  return 3000
}


/** Same pinned TEST project; explicit opt-out to prevent unintended sends. */
export function shouldRunDevBroadcastWorker({nodeEnv,supabaseUrl,mode}) {
  if (nodeEnv !== 'development' || supabaseUrl !== DEV_TASK_TEST_URL) return false
  return (mode ?? 'on') === 'on'
}
