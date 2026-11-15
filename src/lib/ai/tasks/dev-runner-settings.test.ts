import { describe, expect, it } from 'vitest'
import {
  DEV_TASK_TEST_URL, developmentPort, shouldRunDevTaskWorker,
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
  it('honors an explicit CLI port and rejects invalid port values', () => {
    expect(developmentPort([])).toBe(3000)
    expect(developmentPort(['-p','3001'])).toBe(3001)
    expect(developmentPort(['--port=3210'])).toBe(3210)
    expect(() => developmentPort(['--port','0'])).toThrow()
    expect(() => developmentPort(['-p','injected'])).toThrow()
  })
})
