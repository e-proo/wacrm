import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from '../defaults'
import { localizedAdminFallback, localizedHandoffAcknowledgement } from './handoff-service'

describe('multi-agent runtime integration invariants', () => {
  it('uses an admin-specific prompt with no customer handoff sentinel', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', audience: 'admin' })
    expect(prompt).toContain('verified business administrator')
    expect(prompt).not.toContain(HANDOFF_SENTINEL)
    expect(prompt).not.toContain('customer-messaging assistant')
  })

  it('teaches customer mode to prefer native tools before handoff', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      audience: 'customer',
      nativeToolsAvailable: true,
      knowledge: ['some reference'],
    })
    expect(prompt).toContain(HANDOFF_SENTINEL)
    expect(prompt).toContain('use an offered System tool')
    expect(prompt).not.toContain('```tool')
  })

  it('localizes handoff/fallback messages', () => {
    expect(localizedHandoffAcknowledgement('مرحبا')).toContain('تم تحويل')
    expect(localizedHandoffAcknowledgement('hello')).toContain('team member')
    expect(localizedAdminFallback('ما هي التغطيات')).toContain('وكيل الإدارة')
  })

  it('bypasses customer reply slots for admin and wires human handoff', () => {
    const dispatch = readFileSync(new URL('./dispatch.ts', import.meta.url), 'utf8')
    expect(dispatch).toContain("if (decision.plane === 'customer')")
    expect(dispatch).toContain('admin plane bypasses customer reply cap')
    expect(dispatch).toContain('applyAgentHumanHandoff')
    expect(dispatch).toContain('localizedHandoffAcknowledgement')
  })

  it('recovers after an authoritative READ result', () => {
    const loop = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')
    expect(loop).toContain('hasAuthoritativeReadResult')
    expect(loop).toContain('recoverAfterAuthoritativeRead')
    expect(loop).toContain('[agent loop] tool=')
  })

  it('blocks broken admin/handoff publish configurations', () => {
    const builder = readFileSync(new URL('./builder-service.ts', import.meta.url), 'utf8')
    expect(builder).toContain('ADMIN_TOOL_ROUNDS_REQUIRED')
    expect(builder).toContain('HANDOFF_MEMBER_REQUIRED')
    expect(builder).toContain('HANDOFF_MEMBER_INVALID')
  })

  it('keeps trusted-admin routing ahead of customer pause/handoff gates', () => {
    const router = readFileSync(new URL('./router.ts', import.meta.url), 'utf8')
    const adminGate = router.indexOf('const adminDecision = pickAdminAgent')
    const humanGate = router.indexOf('if (ctx.hasHumanAssignee)')
    expect(adminGate).toBeGreaterThan(-1)
    expect(humanGate).toBeGreaterThan(-1)
    expect(adminGate).toBeLessThan(humanGate)
    expect(router).toContain("plane: 'admin'")
    expect(router).toContain('admin_identity_no_admin_route')
    expect(router).toContain('admin_route_target_not_published')
  })

  it('enforces admin purpose + verified identity capabilities before admin tools', () => {
    const policy = readFileSync(new URL('./tool-policy.ts', import.meta.url), 'utf8')
    expect(policy).toContain("context.agentPurpose !== 'admin_operations'")
    expect(policy).toContain('TRUSTED_ADMIN_REQUIRED')
    expect(policy).toContain('ADMIN_CAPABILITY_DENIED')
    expect(policy).toContain('manifest.requiredCapabilities')
  })

  it('keeps the admin coverage template on read/operations tools, not customer-bound proposal tools', () => {
    const migration = readFileSync(
      new URL('../../../../supabase/migrations/070_coverage_agent_template_directional_tools.sql', import.meta.url),
      'utf8',
    )
    const expectedAdminAppend =
      '["coverage.get_rates","coverage.find_offers","coverage.admin_list_offers","coverage.admin_list_requests","change_requests.list_pending"]'
    expect(migration).toContain(expectedAdminAppend)

    const adminUpdate = migration.slice(migration.indexOf('-- Admin operations should read operational coverage data'))
    const appendedList = adminUpdate.match(/\|\| '(\[[^']+\])'::jsonb/)?.[1] ?? ''
    expect(appendedList).toBe(expectedAdminAppend)
    expect(appendedList).not.toContain('coverage.propose_offer')
    expect(appendedList).not.toContain('coverage.propose_request')
  })

  it('registers exact directional coverage executors through the Coverage domain runtime', () => {
    const centralExecutors = readFileSync(
      new URL('../tools/platform/current-executor-registry.ts', import.meta.url),
      'utf8',
    )
    const coverageRuntime = readFileSync(
      new URL('../../services/coverage/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )

    expect(coverageRuntime).toContain("key: 'coverage.get_rates'")
    expect(coverageRuntime).toContain("key: 'coverage.find_offers'")
    expect(coverageRuntime).toContain("key: 'coverage.propose_offer'")
    expect(coverageRuntime).toContain("key: 'coverage.propose_request'")
    expect(coverageRuntime).toContain("key: 'coverage.admin_list_offers'")
    expect(coverageRuntime).toContain("key: 'coverage.admin_list_requests'")
    expect(centralExecutors).toContain('CURRENT_BUSINESS_DOMAIN_RUNTIMES')
    expect(centralExecutors).not.toContain("add('coverage.")
    expect(centralExecutors).toContain("add('change_requests.list_pending', 1")
    expect(centralExecutors).toContain('sanitizeToolResultForModel')
  })

  it('wires change-request creation to admin notification and admin decisions back to the atomic customer outbox', () => {
    const changeRequests = readFileSync(new URL('./change-requests-service.ts', import.meta.url), 'utf8')
    const adminCommands = readFileSync(new URL('./admin-change-commands.ts', import.meta.url), 'utf8')
    const delivery = readFileSync(new URL('./customer-notification-delivery.ts', import.meta.url), 'utf8')
    expect(changeRequests).toContain('notifyTrustedAdminsOfChangeRequest')
    expect(adminCommands).toContain('deliverCustomerOutcomeNotifications')
    expect(adminCommands).toContain('executeApprovedChangeRequest')
    expect(delivery).toContain("db.rpc('claim_customer_business_notifications'")
    expect(delivery).not.toContain("db.rpc('claim_customer_intent_notifications'")
    expect(delivery).toContain('customer-intent-notification:')
  })
})
