import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path,'utf8')

describe('SOF-27 Phase 22 cleanup inventory — no deletion without release proof', () => {
  it('preserves the single domain composition root and historical task versions', () => {
    const platform = read('src/lib/ai/tasks/current-platform.ts')
    expect(platform).toContain('COVERAGE_SOURCING_TASK_MODULE')
    expect(platform).toContain('SERVICE_PROMOTION_TASK_MODULE')
    expect(platform).toContain('COVERAGE_SOURCING_TRIGGER_HANDLER_V2')
    expect(platform).toContain('SERVICE_PROMOTION_TRIGGER_HANDLER_V2')
    const coverage = read('src/lib/services/coverage/agent-task.ts')
    expect(coverage).toContain('COVERAGE_SOURCING_TASK_TYPE')
    const service = read('src/lib/services/service-catalog/agent-task.ts')
    expect(service).toContain('SERVICE_PROMOTION_TASK_TYPE_V2')
  })

  it('retains Meta default routing, guarded OpenWA and inbound message handlers', () => {
    const router = read('src/lib/whatsapp/transport/router.ts')
    expect(router).toContain('if (!connectionId) return resolveMetaTransport(db, accountId)')
    expect(router).toContain('new GuardedOpenWATransport(serverDb, resolved.transport)')
    expect(existsSync('src/lib/whatsapp/transport/openwa/operational-consent-gate.ts')).toBe(true)
    expect(existsSync('src/lib/whatsapp/transport/openwa/support-diagnostics.ts')).toBe(true)
    expect(existsSync('src/lib/ai/tasks/reply-correlation.ts')).toBe(true)
  })

  it('retains rollback and lease recovery controls throughout Stage 21 preparation', () => {
    const cutover = read('src/app/api/agent-tasks/cutover/route.ts')
    expect(cutover).toContain("mode !== 'pilot' && mode !== 'disabled'")
    const worker = read('src/lib/ai/tasks/trigger-worker.ts')
    expect(worker).toContain('reap_expired_agent_task_trigger_firings')
    expect(worker).toContain('claim_next_agent_task_trigger_firing')
    const taskRoute = read('src/app/api/agent-tasks/route.ts')
    expect(taskRoute).toContain("requireAgentCapability('agents.manage_tasks')")
  })

  it('keeps old Builder and new atomic publish routes until usage and rollback proof exist', () => {
    const api = read('src/app/api/ai-agents/route.ts')
    const publish = read('src/app/api/ai-agents/[id]/revisions/[revisionId]/publish/route.ts')
    expect(api).toContain('createAgentFromTemplate(')
    expect(api).toContain('publishAgentRevision(')
    expect(publish).toContain('publishAgentRevisionAtomic(')
    expect(publish).toContain("requireAgentCapability('agents.publish')")
    expect(existsSync('supabase/migrations/193_agent_task_trigger_exhausted_lease_reaper.sql')).toBe(true)
  })

  it('does not wire the Phase 21 draft policy into existing send, task creation, or publish routes', () => {
    // This is a contract-only groundwork step. Enforcement requires a separate
    // audited server-backed rollout transition and explicit TEST acceptance.
    const sources = [
      'src/app/api/ai-agents/route.ts',
      'src/app/api/ai-agents/[id]/revisions/[revisionId]/publish/route.ts',
      'src/app/api/agent-tasks/route.ts',
      'src/lib/ai/tasks/trigger-worker.ts',
      'src/lib/whatsapp/transport/guardrails.ts',
    ]
    for (const path of sources) {
      expect(read(path)).not.toContain('evaluateAgentTaskBuilderRollout(')
    }
  })
})
