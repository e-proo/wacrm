import test from 'node:test'
import assert from 'node:assert/strict'
import { isPinnedTestProject, validateEnvironment, JOBS } from './selfhost-test-scheduler.mjs'

const testEnv = {
  WACRM_TEST_WORKERS_ACK: 'I_ACCEPT_TEST_WHATSAPP_SENDS',
  NEXT_PUBLIC_SUPABASE_URL: 'https://pqirsnfupofhulmewakq.supabase.co',
  CRON_SECRET: '12345678901234567890123456789012',
  AUTOMATION_CRON_SECRET: 'abcdefghijklmnopabcdefghijklmnop',
}

test('only exact TEST project is accepted', () => {
  assert.equal(isPinnedTestProject(testEnv.NEXT_PUBLIC_SUPABASE_URL), true)
  for (const bad of [
    'http://pqirsnfupofhulmewakq.supabase.co',
    'https://pqirsnfupofhulmewakq.supabase.co.evil.test',
    'https://other.supabase.co',
    'https://pqirsnfupofhulmewakq.supabase.co/path',
    'https://pqirsnfupofhulmewakq.supabase.co?redirect=1',
    'invalid',
  ]) assert.equal(isPinnedTestProject(bad), false)
})

test('requires deliberate acknowledgement and strong secrets', () => {
  assert.doesNotThrow(() => validateEnvironment(testEnv))
  assert.throws(() => validateEnvironment({ ...testEnv, WACRM_TEST_WORKERS_ACK: '' }))
  assert.throws(() => validateEnvironment({ ...testEnv, NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co' }))
  assert.throws(() => validateEnvironment({ ...testEnv, CRON_SECRET: '' }))
  assert.throws(() => validateEnvironment({ ...testEnv, AUTOMATION_CRON_SECRET: 'your-secret' }))
})

test('six independent jobs use fixed authentication contracts', () => {
  assert.equal(new Set(JOBS.map(job => job.path)).size, JOBS.length)
  assert.equal(JOBS.length, 6)
  for (const job of JOBS) {
    assert.equal(job.path.startsWith('/api/'), true)
    assert.ok(job.intervalMs >= 15_000)
    assert.ok(['CRON_SECRET', 'AUTOMATION_CRON_SECRET'].includes(job.secret))
    assert.equal(job.secret === 'AUTOMATION_CRON_SECRET', job.method === 'GET')
  }
})
