import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { createHash } from 'node:crypto'
import { resolveOpenWAClient } from './credentials'
import { hydrateOpenWAInboundMessageMedia, mirrorOpenWAInboundMedia } from './inbound-media'
vi.mock('./credentials', () => ({ resolveOpenWAClient: vi.fn() }))

function db(): SupabaseClient { return { from() { const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { session_id: 'sess-1' }, error: null }) }; return b } } as unknown as SupabaseClient }
type UploadResult = { error: null | { message: string } }
function storage(upload: ReturnType<typeof vi.fn<() => Promise<UploadResult>>> = vi.fn(async () => ({ error: null }))) { return { upload, api: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example/media' } }) }) } } }

describe('OpenWA inbound media mirror', () => {
  it('stores a signed small PDF inline even when gateway archive GET is unavailable', async () => {
    const downloadMedia = vi.fn()
    vi.mocked(resolveOpenWAClient).mockResolvedValue({
      credentials:{} as never, client:{downloadMedia} as never,
    })
    const s = storage()
    const result = await mirrorOpenWAInboundMedia({
      db:db(), storage:s.api as never, accountId:'acct-1', connectionId:'conn-1',
      kind:'document', media:{id:'pdf-1',mime_type:'application/pdf',filename:'report.pdf'},
      messageTimestamp:'1792950000', signedInlineMedia:Buffer.from('%PDF-1.4').toString('base64'),
    })
    expect(result).toBe('https://storage.example/media')
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(s.upload).toHaveBeenCalledTimes(1)
  })

  it('downloads with scoped OpenWA client and mirrors into WACRM storage', async () => { const downloadMedia = vi.fn(async () => ({ buffer: Buffer.from('abc'), contentType: 'image/jpeg', contentLength: 3 })); vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never }); const s = storage(); const result = await mirrorOpenWAInboundMedia({ db: db(), storage: s.api as never, accountId: 'acct-1', connectionId: 'conn-1', kind: 'image', media: { id: 'media-1', chat_id: '123@c.us', mime_type: 'image/jpeg', file_size: 3 }, messageTimestamp: '1792950000' }); expect(result).toBe('https://storage.example/media'); expect(downloadMedia).toHaveBeenCalledWith('sess-1', 'media-1', '123@c.us', 'media:media-1'); expect(s.upload).toHaveBeenCalledTimes(1) })
  it('rejects MIME mismatch before provider download', async () => { const downloadMedia = vi.fn(); vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never }); await expect(mirrorOpenWAInboundMedia({ db: db(), storage: storage().api as never, accountId: 'acct-1', connectionId: 'conn-1', kind: 'image', media: { id: 'media-1', mime_type: 'application/pdf' }, messageTimestamp: '1' })).rejects.toMatchObject({ code: 'invalid_request' }); expect(downloadMedia).not.toHaveBeenCalled() })
  it('rejects declared oversize before provider download', async () => { const downloadMedia = vi.fn(); vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never }); await expect(mirrorOpenWAInboundMedia({ db: db(), storage: storage().api as never, accountId: 'acct-1', connectionId: 'conn-1', kind: 'document', media: { id: 'media-1', mime_type: 'application/pdf', file_size: MEDIA_MAX_BYTES + 1 }, messageTimestamp: '1' })).rejects.toMatchObject({ code: 'invalid_request' }); expect(downloadMedia).not.toHaveBeenCalled() })
  it('retries a read-only 404 while the gateway media archive becomes ready', async () => {
    const downloadMedia = vi.fn()
      .mockRejectedValueOnce(new WhatsAppTransportError('invalid_request', 'OpenWA request rejected (404)'))
      .mockResolvedValueOnce({ buffer: Buffer.from('abc'), contentType: 'application/pdf', contentLength: 3 })
    vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never })
    const result = await mirrorOpenWAInboundMedia({
      db: db(), storage: storage().api as never, accountId: 'acct-1', connectionId: 'conn-1',
      kind: 'document', media: { id: 'doc-1', chat_id: '123@c.us', mime_type: 'application/pdf' },
      messageTimestamp: '1792950000',
    })
    expect(result).toBe('https://storage.example/media')
    expect(downloadMedia).toHaveBeenCalledTimes(2)
  })

  it('returns null when controlled storage upload fails', async () => { const downloadMedia = vi.fn(async () => ({ buffer: Buffer.from('abc'), contentType: 'application/pdf', contentLength: 3 })); vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never }); const s = storage(vi.fn(async (): Promise<UploadResult> => ({ error: { message: 'storage down' } }))); await expect(mirrorOpenWAInboundMedia({ db: db(), storage: s.api as never, accountId: 'acct-1', connectionId: 'conn-1', kind: 'document', media: { id: 'media-1', chat_id: '123@c.us', mime_type: 'application/pdf' }, messageTimestamp: '1' })).resolves.toBeNull() })
})

// Regression: a slow/unavailable archive must not prevent WACRM from
// persisting the inbound document row. A replay can hydrate a missing URL.
describe('OpenWA media hydration after message persistence', () => {
  it('writes a scoped media URL for an already inserted document', async () => {
    const updates: Record<string, unknown>[] = []
    const dbClient = {
      from(table: string) {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: table === 'messages' ? { media_url: null } : { session_id: 'sess-1' }, error: null })
        b.update = (patch: Record<string, unknown>) => { updates.push(patch); return b }
        b.is = async () => ({ error: null })
        return b
      },
    } as unknown as SupabaseClient
    const downloadMedia = vi.fn(async () => ({ buffer: Buffer.from('pdf'), contentType: 'application/pdf', contentLength: 3 }))
    vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never })
    const s = storage()
    const message = {
      provider: 'openwa' as const, connectionId: 'conn-1', type: 'document', timestamp: '1792950000',
      document: { id: 'native@c.us_123', chat_id: '123@c.us', mime_type: 'application/pdf', filename: 'report.pdf' },
    } as never
    expect(await hydrateOpenWAInboundMessageMedia({
      db: dbClient, storage: s.api as never, accountId: 'acct-1',
      conversationId: 'conv-1', inboundMessageId: 'msg-1', message,
    })).toBe(true)
    expect(updates).toEqual([{ media_url: 'https://storage.example/media' }])
    expect(s.upload).toHaveBeenCalledTimes(1)
    const path = (s.upload.mock.calls[0] as unknown as [string])[0]
    expect(path).toContain(createHash('sha256').update('conn-1:native@c.us_123').digest('hex').slice(0, 20))
    expect(path).not.toContain('native@c.us')
  })

  it('skips already hydrated media on replay without another download', async () => {
    const client = { from: () => {
      const b: Record<string, unknown> = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { media_url: 'https://existing.example' }, error: null }) }
      return b
    } } as unknown as SupabaseClient
    const downloadMedia = vi.fn()
    vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { downloadMedia } as never })
    expect(await hydrateOpenWAInboundMessageMedia({
      db: client, storage: storage().api as never, accountId: 'acct-1',
      conversationId: 'conv-1', inboundMessageId: 'msg-1',
      message: { provider: 'openwa', connectionId: 'conn-1', type: 'video', timestamp: '1', video: { id: 'v1', mime_type: 'video/mp4' } } as never,
    })).toBe(false)
    expect(downloadMedia).not.toHaveBeenCalled()
  })
})
