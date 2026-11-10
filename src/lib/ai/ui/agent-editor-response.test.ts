import { describe, expect, it } from 'vitest'
import { readAgentEditorJson, tryReadAgentEditorJson } from './agent-editor-response'

describe('agent editor API response guard', () => {
  it('accepts valid JSON on successful responses', async () => {
    const response = Response.json({ revision: { id: 'draft-1' } })
    await expect(readAgentEditorJson(response, 'ar', 'loadRevision')).resolves.toEqual({
      revision: { id: 'draft-1' },
    })
  })

  it('preserves structured API errors for the caller to localize', async () => {
    const response = Response.json({ error: 'Revision not found', code: 'REVISION_NOT_FOUND' }, { status: 404 })
    await expect(readAgentEditorJson(response, 'en', 'saveRevision')).resolves.toEqual({
      error: 'Revision not found',
      code: 'REVISION_NOT_FOUND',
    })
  })

  it('explains HTML failures with HTTP status without showing raw markup', async () => {
    const response = new Response('<!DOCTYPE html><html><body>secret diagnostics</body></html>', {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    await expect(readAgentEditorJson(response, 'ar', 'saveRevision')).rejects.toThrow(
      /JSON.*HTML.*HTTP 500/,
    )
  })

  it('rejects HTML even with HTTP 200 instead of treating it as saved', async () => {
    const response = new Response('<!DOCTYPE html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    await expect(readAgentEditorJson(response, 'en', 'saveTools')).rejects.toThrow(
      /non-JSON.*HTTP 200/,
    )
  })

  it('rejects malformed JSON and non-object payloads', async () => {
    const malformed = new Response('{ broken', {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
    await expect(readAgentEditorJson(malformed, 'en', 'loadTools')).rejects.toThrow(
      /malformed JSON.*HTTP 502/,
    )
    const array = Response.json([])
    await expect(readAgentEditorJson(array, 'ar', 'loadTools')).rejects.toThrow(
      /بيانات بصيغة غير متوقعة/,
    )
  })

  it('isolates optional panel failures from the editor load', async () => {
    const html = new Response('<html>error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    await expect(tryReadAgentEditorJson(html, 'ar', 'loadConnections')).resolves.toBeNull()
    await expect(tryReadAgentEditorJson(null, 'ar', 'loadMembers')).resolves.toBeNull()
    await expect(tryReadAgentEditorJson(Response.json({ members: [] }), 'ar', 'loadMembers'))
      .resolves.toEqual({ members: [] })
  })
})
