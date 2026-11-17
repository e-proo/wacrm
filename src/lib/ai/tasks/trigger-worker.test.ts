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

import { processAgentTaskTriggerQueue } from './trigger-worker'

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
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'materialize_agent_task_trigger_firings') {
        return { data: { schedule_firings: 0, business_event_firings: 0 }, error: null }
      }
      if (name === 'claim_next_agent_task_trigger_firing') {
        claimOwner = String(args.p_worker_id)
        return { data: { id: 'firing-1' }, error: null }
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

    expect(claimOwner).toMatch(/^scheduler:[0-9a-f-]{36}$/)
    expect(rpc).toHaveBeenCalledWith('complete_agent_task_trigger_firing', {
      p_firing_id: 'firing-1',
      p_worker_id: claimOwner,
      p_task_id: 'task-1',
    })
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, dead: 0 })
  })
})
