import { describe, expect, it } from 'vitest'
import { resumeAgent } from './agents-service'

function makeClient(publishedRevisionCount: number) {
  let agentRead = true
  const updates: Array<Record<string, unknown>> = []

  const client = {
    from(table: string) {
      if (table === 'ai_agent_revisions') {
        const result = { data: null, count: publishedRevisionCount, error: null }
        const builder = {
          select() { return builder },
          eq() { return builder },
          limit() { return Promise.resolve(result) },
        }
        return builder
      }

      if (table === 'ai_agents') {
        if (agentRead) {
          agentRead = false
          const builder = {
            select() { return builder },
            eq() { return builder },
            maybeSingle() {
              return Promise.resolve({
                data: { id: 'agent-1', status: 'paused', version: 7 },
                error: null,
              })
            },
          }
          return builder
        }

        const builder = {
          update(value: Record<string, unknown>) {
            updates.push(value)
            return builder
          },
          eq() { return builder },
          select() { return builder },
          maybeSingle() {
            return Promise.resolve({
              data: {
                id: 'agent-1',
                account_id: 'acc-1',
                system_key: null,
                slug: 'custom-agent',
                name: 'Custom agent',
                description: null,
                purpose: 'custom',
                status: 'active',
                published_revision_id: 'rev-1',
                version: 8,
                created_at: '2026-09-27T00:00:00Z',
                updated_at: '2026-09-27T00:00:00Z',
              },
              error: null,
            })
          },
        }
        return builder
      }

      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client, updates }
}

describe('resumeAgent', () => {
  it('rejects activation when no published revision exists', async () => {
    const { client, updates } = makeClient(0)

    await expect(
      resumeAgent(client as never, {
        accountId: 'acc-1',
        agentId: 'agent-1',
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_NOT_PUBLISHED',
      status: 409,
    })

    expect(updates).toHaveLength(0)
  })

  it('uses the head/count result and resumes when a published revision exists', async () => {
    const { client, updates } = makeClient(1)

    const agent = await resumeAgent(client as never, {
      accountId: 'acc-1',
      agentId: 'agent-1',
      actorUserId: 'user-1',
    })

    expect(agent.status).toBe('active')
    expect(updates).toEqual([
      {
        status: 'active',
        version: 8,
        updated_by: 'user-1',
      },
    ])
  })
})
