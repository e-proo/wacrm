import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/103_change_request_action_identity.sql', import.meta.url),
  'utf8',
)
const service = readFileSync(
  new URL('../../ai/runtime/change-requests-service.ts', import.meta.url),
  'utf8',
)
const executor = readFileSync(
  new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
  'utf8',
)
const intents = readFileSync(
  new URL('../intents/ai-tool-runtime.ts', import.meta.url),
  'utf8',
)
const intentsService = readFileSync(
  new URL('../intents/intents-service.ts', import.meta.url),
  'utf8',
)
const coverage = readFileSync(
  new URL('../../ai/tools/business-handoff.ts', import.meta.url),
  'utf8',
)
const services = readFileSync(
  new URL('../service-catalog/ai-tool-runtime.ts', import.meta.url),
  'utf8',
)
const pricingRules = readFileSync(
  new URL('../pricing-rules/ai-tool-runtime.ts', import.meta.url),
  'utf8',
)
const fxCustomer = readFileSync(
  new URL('../../ai/tools/fx-v2-tools.ts', import.meta.url),
  'utf8',
)
const fxAdmin = readFileSync(
  new URL('../../ai/tools/fx-v2-admin-tools.ts', import.meta.url),
  'utf8',
)

describe('Change Request action identity expansion', () => {
  it('adds nullable exact action identity while keeping legacy target metadata', () => {
    expect(migration).toContain('add column if not exists action_key text')
    expect(migration).toContain('add column if not exists action_version integer')
    expect(migration).toContain('change_requests_action_identity_check')
    expect(migration).toContain('change_requests_target_type_check')
    expect(migration).toContain("target_type ~ '^[a-z][a-z0-9_]*$'")
    expect(migration).not.toContain("'fx_trade_request'::text")
    expect(migration).not.toContain("'service_intent'::text")
  })

  it('keeps historical content digests byte-compatible and centralizes new digest calculation', () => {
    expect(migration).toContain('change_request_content_digest')
    expect(migration).toContain('when p_action_key is null then')
    expect(migration).toContain(
      "p_target_type || '|' || coalesce(p_target_id::text, '') || '|'",
    )
    expect(migration).toContain("'action:' || p_action_key || '@'")
  })

  it('uses additive v3 create and v2 claim boundaries without deleting old RPCs', () => {
    expect(migration).toContain('create_change_request_v3')
    expect(migration).toContain('claim_change_request_execution_v2')
    expect(service).toContain("rpc('create_change_request_v3'")
    expect(service).toContain('p_action_key: input.actionKey ?? null')
    expect(service).toContain('p_action_version: input.actionVersion ?? null')
    expect(executor).toContain("'claim_change_request_execution_v2'")
    expect(executor).toContain('actionKey: row.action_key')
    expect(executor).toContain('actionVersion: row.action_version')
  })

  it('dual-writes exact actions for every native business domain', () => {
    expect(intents).toContain("actionKey: 'intents.decision.apply'")
    expect(intents).toContain('actionVersion: 1')

    expect(coverage).toContain("actionKey: 'coverage.offer.create'")
    expect(coverage).toContain("actionKey: 'coverage.request.create'")

    expect(fxCustomer).toContain("actionKey: 'exchange_rates.trade.decide'")
    expect(fxAdmin).toContain("actionKey: 'exchange_rates.pair.publish'")
    expect(fxAdmin).toContain("actionKey: 'exchange_rates.trade.decide'")

    expect(services).toContain("actionKey: 'services.update'")
    expect(services).toContain('actionVersion: 1')
    expect(pricingRules).toContain(
      "actionKey: 'pricing_rules.create_and_attach'",
    )
    expect(pricingRules).toContain('actionVersion: 1')
  })

  it('keeps non-authoritative intent review handoff out of the approval engine', () => {
    expect(intentsService).not.toContain('createChangeRequest({')
    expect(intentsService).toContain("status: 'forwarded_to_admin'")
    expect(intentsService).toContain('changeRequest: null')
  })

  it('keeps create_and_attach compatible with the existing pricing proposal path', () => {
    expect(migration).toContain("'create_and_attach'")
    expect(pricingRules).toContain("intent: 'create_and_attach'")
  })
})
