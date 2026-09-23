import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/104_change_request_legacy_claim_action_digest.sql', import.meta.url),
  'utf8',
)

describe('legacy change claim rolling compatibility', () => {
  it('preserves the old RPC signature and return contract', () => {
    expect(migration).toContain(
      'create or replace function public.claim_change_request_execution(',
    )
    expect(migration).toContain('target_type text')
    expect(migration).toContain('target_id uuid')
    expect(migration).toContain('intent text')
    expect(migration).not.toContain('action_key text,')
    expect(migration).not.toContain('action_version integer,')
  })

  it('validates action-aware rows through the canonical digest helper', () => {
    expect(migration).toContain('public.change_request_content_digest(')
    expect(migration).toContain('v_row.action_key')
    expect(migration).toContain('v_row.action_version')
  })

  it('keeps the old claim RPC service-role only', () => {
    expect(migration).toContain(
      'revoke execute on function public.claim_change_request_execution(uuid, uuid)',
    )
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('to service_role')
  })
})
