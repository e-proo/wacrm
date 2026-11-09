import { describe, expect, it } from 'vitest'
import { parseOpenWAApiResponse } from './browser-api-response'

describe('OpenWA settings API response', () => {
  it('reads normal JSON responses without changing their fields', async () => {
    const response = new Response(JSON.stringify({ connections: [{ id: 'c1' }] }), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    await expect(parseOpenWAApiResponse(response)).resolves.toEqual({ connections: [{ id: 'c1' }] })
  })

  it('keeps intended JSON error responses for the calling UI to classify', async () => {
    const response = new Response(JSON.stringify({ error: 'Admin access required' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    })
    await expect(parseOpenWAApiResponse(response)).resolves.toEqual({ error: 'Admin access required' })
  })

  it('reports a missing local route instead of parsing an HTML 404 as JSON', async () => {
    const response = new Response('<!DOCTYPE html><html><body>404</body></html>', {
      status: 404, headers: { 'content-type': 'text/html' },
    })
    await expect(parseOpenWAApiResponse(response)).rejects.toThrow('WACRM OpenWA API route not found (HTTP 404)')
  })

  it('rejects malformed JSON and unexpected HTML without reflecting either body', async () => {
    const invalid = new Response('<secret>', { status: 200, headers: { 'content-type': 'application/json' } })
    await expect(parseOpenWAApiResponse(invalid)).rejects.toThrow('invalid JSON')
    const html = new Response('<secret>', { status: 502, headers: { 'content-type': 'text/html' } })
    await expect(parseOpenWAApiResponse(html)).rejects.toThrow('unexpected response (HTTP 502)')
  })
})
