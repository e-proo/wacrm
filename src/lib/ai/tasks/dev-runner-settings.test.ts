import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  DEV_TASK_TEST_URL, developmentPort, shouldRunDevTaskWorker, shouldRunDevBroadcastWorker,
} from '../../../../scripts/dev-agent-task-config.mjs'

describe('local TEST dev runner safety gate and port', () => {
  it('starts by default only on pinned TEST and fails closed elsewhere', () => {
    const params = {nodeEnv:'development',supabaseUrl:DEV_TASK_TEST_URL}
    expect(shouldRunDevTaskWorker(params)).toBe(true)
    expect(shouldRunDevTaskWorker({...params,mode:'off'})).toBe(false)
    expect(shouldRunDevTaskWorker({...params,mode:'unknown'})).toBe(false)
    expect(shouldRunDevTaskWorker({...params,nodeEnv:'production'})).toBe(false)
    expect(shouldRunDevTaskWorker({...params,supabaseUrl:'https://production.supabase.co'})).toBe(false)
    expect(shouldRunDevTaskWorker({...params,supabaseUrl:DEV_TASK_TEST_URL+'.evil'})).toBe(false)
  })
  it('enables the broadcast worker only on the pinned TEST project', () => {
    const base = { nodeEnv:'development', supabaseUrl:DEV_TASK_TEST_URL }
    expect(shouldRunDevBroadcastWorker(base)).toBe(true)
    expect(shouldRunDevBroadcastWorker({ ...base, mode:'off' })).toBe(false)
    expect(shouldRunDevBroadcastWorker({ ...base, mode:'wrong' })).toBe(false)
    expect(shouldRunDevBroadcastWorker({ ...base, nodeEnv:'production' })).toBe(false)
    expect(shouldRunDevBroadcastWorker({ ...base, supabaseUrl:'https://production.supabase.co' })).toBe(false)
  })
  it('honors an explicit CLI port and rejects invalid port values', () => {
    expect(developmentPort([])).toBe(3000)
    expect(developmentPort(['-p','3001'])).toBe(3001)
    expect(developmentPort(['--port=3210'])).toBe(3210)
    expect(() => developmentPort(['--port','0'])).toThrow()
    expect(() => developmentPort(['-p','injected'])).toThrow()
  })
  it('loads the real dev runner with native Node ESM before any server starts', () => {
    // --port=0 aborts immediately after module imports and env loading.
    // This catches the @next/env CommonJS named-export error under Node 22
    // without starting Next.js, a timer, or any WhatsApp work.
    const result = spawnSync(
      process.execPath,
      ['scripts/dev-with-agent-tasks.mjs', '--port=0'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, WACRM_DEV_AGENT_TASK_WORKER: 'off' },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Invalid Next.js development port')
  })
})
