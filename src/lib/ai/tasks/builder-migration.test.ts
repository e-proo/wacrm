import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Agent Builder V2 migration contract', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/116_ai_agent_builder_v2.sql'),
    'utf8',
  )
  const atomicSql = readFileSync(
    resolve(
      process.cwd(),
      'supabase/migrations/117_ai_agent_builder_v2_atomic_config.sql',
    ),
    'utf8',
  )

  it('is additive and preserves reactive behavior for existing revisions', () => {
    expect(sql).toContain('add column if not exists operational_mode')
    expect(sql).toContain("default 'reactive'")
    expect(sql).toContain('add column if not exists outreach_policy')
    expect(sql).toContain("default '{}'::jsonb")
    expect(sql.toLowerCase()).not.toContain('drop table')
    expect(sql.toLowerCase()).not.toContain('delete from')
  })

  it('constrains operational mode and policy shape', () => {
    expect(sql).toContain("operational_mode in ('reactive','outbound','both')")
    expect(sql).toContain("jsonb_typeof(outreach_policy) = 'object'")
  })

  it('keeps Builder config + capability persistence service-role-only and atomic', () => {
    expect(atomicSql).toContain('update_ai_agent_builder_v2_config')
    expect(atomicSql).toContain('for update')
    expect(atomicSql).toContain('replace_ai_agent_revision_capabilities')
    expect(atomicSql).toContain('from public,anon,authenticated')
    expect(atomicSql).toContain('to service_role')
    expect(atomicSql.toLowerCase()).not.toContain('drop table')
  })
})
