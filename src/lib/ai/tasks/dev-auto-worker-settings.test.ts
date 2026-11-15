import { describe, expect, it } from 'vitest'
import {
  shouldStartDevAgentTaskWorker,
  TEST_SUPABASE_URL,
} from './dev-auto-worker-settings'

const pinned = {
  nodeEnv: 'development',
  nextRuntime: 'nodejs',
  supabaseUrl: TEST_SUPABASE_URL,
}

describe('local Agent Task auto-worker start gate', () => {
  it('starts automatically on pinned TEST Node.js development server only', () => {
    expect(shouldStartDevAgentTaskWorker(pinned)).toBe(true)
    expect(shouldStartDevAgentTaskWorker({...pinned,mode:'on'})).toBe(true)
  })

  it('never auto-runs in production, serverless, Edge or unknown projects', () => {
    for (const variant of [
      {...pinned,nodeEnv:'production'},
      {...pinned,nodeEnv:'test'},
      {...pinned,nextRuntime:'edge'},
      {...pinned,nextRuntime:undefined},
      {...pinned,supabaseUrl:'https://another-project.supabase.co'},
      {...pinned,supabaseUrl:'http://pqirsnfupofhulmewakq.supabase.co'},
      {...pinned,supabaseUrl:TEST_SUPABASE_URL+'.attacker.tld'},
      {...pinned,supabaseUrl:undefined},
    ]) expect(shouldStartDevAgentTaskWorker(variant)).toBe(false)
  })

  it('allows explicit per-developer stop and fails closed on malformed flags', () => {
    expect(shouldStartDevAgentTaskWorker({...pinned,mode:'off'})).toBe(false)
    expect(shouldStartDevAgentTaskWorker({...pinned,mode:'false'})).toBe(false)
    expect(shouldStartDevAgentTaskWorker({...pinned,mode:'enabled'})).toBe(false)
    expect(shouldStartDevAgentTaskWorker({...pinned,mode:'unknown'})).toBe(false)
  })
})
