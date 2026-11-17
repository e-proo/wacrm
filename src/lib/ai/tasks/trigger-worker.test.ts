import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, start, normalizeFiring } = vi.hoisted(() => ({
  rpc: vi.fn(),
  start: vi.fn(),
  normalizeFiring: vi.fn(),
}))

vi.mock('../admin-client', () => ({ supabaseAdmin: () => ({ rpc }) }))
vi.mock('./triggers', () => ({
  normalizeAgentTaskTriggerFiring: normalizeFiring,
}))
vi.mock('./current-platform', () => ({
  CURRENT_AGENT_TASK_TRIGGER_REGISTRY: {
    get: () => ({ start }),
  },
}))

import { normalizeAgentTaskTriggerWorkerLimit, processAgentTaskTriggerQueue } from './trigger-worker'

describe('trigger worker lease ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    normalizeFiring.mockReturnValue({
      firingId: 'firing-1',
      taskType: 'coverage',
      taskTypeVersion: 1,
    })
    start.mockResolvedValue({ taskId: 'task-1' })
  })

  it('uses the unique claim owner for successful completion, not the outer worker id', async () => {
    let claimOwner = ''
    let requestOwner = ''
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        requestOwner = String(args.p_worker_id)
        claimOwner = `${requestOwner}:00000000-0000-4000-8000-000000000186`
        return { data: { id: 'firing-1', claim_owner: claimOwner }, error: null }
      }
      if (name === 'complete_agent_task_trigger_firing') {
        return { data: args.p_worker_id === claimOwner, error: null }
      }
      if (name === 'fail_agent_task_trigger_firing') {
        throw new Error('Unexpected fail RPC: completion must use the claim owner')
      }
      throw new Error('Unexpected RPC: ' + name)
    })

    const result = await processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 })

    expect(requestOwner).toMatch(/^scheduler:[0-9a-f-]{36}$/)
    expect(claimOwner).toBe(`${requestOwner}:00000000-0000-4000-8000-000000000186`)
    expect(rpc).toHaveBeenCalledWith('complete_agent_task_trigger_firing', {
      p_firing_id: 'firing-1',
      p_worker_id: claimOwner,
      p_task_id: 'task-1',
    })
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, dead: 0 })
  })

  it('fails closed without a DB-minted claim owner', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        return { data: { id: 'firing-1' }, error: null }
      }
      throw new Error('Unexpected RPC after missing claim owner: ' + name)
    })
    await expect(processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 }))
      .rejects.toThrow('AGENT_TASK_TRIGGER_DB_CLAIM_OWNER_REQUIRED')
    expect(start).not.toHaveBeenCalled()
  })
})


describe('trigger worker bounded limits', () => {
  it('normalizes non-finite, fractional, and out-of-range limits before DB work', () => {
    expect(normalizeAgentTaskTriggerWorkerLimit()).toBe(20)
    expect(normalizeAgentTaskTriggerWorkerLimit(Number.NaN)).toBe(1)
    expect(normalizeAgentTaskTriggerWorkerLimit(Infinity)).toBe(1)
    expect(normalizeAgentTaskTriggerWorkerLimit(-Infinity)).toBe(1)
    expect(normalizeAgentTaskTriggerWorkerLimit(2.9)).toBe(2)
    expect(normalizeAgentTaskTriggerWorkerLimit(0)).toBe(1)
    expect(normalizeAgentTaskTriggerWorkerLimit(999)).toBe(100)
  })
})

describe('trigger worker admission guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a blank worker identity before any database RPC', async () => {
    await expect(processAgentTaskTriggerQueue({ workerId: '  ' }))
      .rejects.toThrow('AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('caps materialization and claim iterations for an oversized requested limit', async () => {
    let claimCalls = 0
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        expect(args.p_limit).toBe(400)
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        claimCalls += 1
        return { data: null, error: null }
      }
      throw new Error('Unexpected RPC: ' + name)
    })
    const result = await processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 100000 })
    expect(claimCalls).toBe(1)
    expect(result).toMatchObject({ claimed: 0, completed: 0, failed: 0, dead: 0 })
  })
})

describe('trigger worker failure isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    normalizeFiring.mockReturnValue({
      firingId: 'firing-1',
      taskType: 'coverage',
      taskTypeVersion: 1,
    })
  })

  it('records a handler failure with the database claim owner and bounded retry delay', async () => {
    let owner = ''
    start.mockRejectedValue(new Error('temporary handler failure'))
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        owner = String(args.p_worker_id) + ':00000000-0000-4000-8000-000000000186'
        return { data: { id: 'firing-1', claim_owner: owner }, error: null }
      }
      if (name === 'fail_agent_task_trigger_firing') {
        expect(args).toEqual({
          p_firing_id: 'firing-1',
          p_worker_id: owner,
          p_error: 'temporary handler failure',
          p_delay_secs: 60,
        })
        return { data: 'failed', error: null }
      }
      throw new Error('Unexpected RPC: ' + name)
    })
    const result = await processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 })
    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1, dead: 0 })
    expect(rpc).not.toHaveBeenCalledWith('complete_agent_task_trigger_firing', expect.anything())
  })

  it('stops before invoking a handler when the claimed firing cannot be normalized', async () => {
    normalizeFiring.mockReturnValue(null)
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        return {
          data: { id: 'firing-1', claim_owner: String(args.p_worker_id) + ':00000000-0000-4000-8000-000000000186' },
          error: null,
        }
      }
      throw new Error('Unexpected RPC: ' + name)
    })
    await expect(processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 }))
      .rejects.toThrow('AGENT_TASK_TRIGGER_FIRING_INVALID')
    expect(start).not.toHaveBeenCalled()
  })
})

describe('trigger worker dead-letter and database failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    normalizeFiring.mockReturnValue({
      firingId: 'firing-1',
      taskType: 'coverage',
      taskTypeVersion: 1,
    })
  })

  it('counts a dead-letter outcome without treating it as a completed task', async () => {
    start.mockRejectedValue(new Error('permanent handler failure'))
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        return {
          data: {
            id: 'firing-1',
            claim_owner: String(args.p_worker_id) + ':00000000-0000-4000-8000-000000000186',
          },
          error: null,
        }
      }
      if (name === 'fail_agent_task_trigger_firing') {
        expect(args.p_error).toBe('permanent handler failure')
        expect(args.p_delay_secs).toBe(60)
        return { data: 'dead', error: null }
      }
      throw new Error('Unexpected RPC: ' + name)
    })

    const result = await processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 })
    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 0, dead: 1 })
    expect(rpc).not.toHaveBeenCalledWith('complete_agent_task_trigger_firing', expect.anything())
  })

  it('aborts before claiming when materialization fails', async () => {
    const databaseError = new Error('materialization unavailable')
    rpc.mockResolvedValue({ data: null, error: databaseError })

    await expect(processAgentTaskTriggerQueue({ workerId: 'scheduler', limit: 1 }))
      .rejects.toThrow('materialization unavailable')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(
      'materialize_agent_task_trigger_firings',
      expect.objectContaining({ p_limit: 4 }),
    )
    expect(start).not.toHaveBeenCalled()
  })
})
