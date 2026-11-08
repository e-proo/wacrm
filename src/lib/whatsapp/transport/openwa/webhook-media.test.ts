import { describe, expect, it } from 'vitest'
import { extractOpenWASignedInlineMedia } from './webhook-media'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'

const envelope = (media: unknown) => ({
  eventId:'evt', timestamp:'2026-11-08T19:00:00Z', sessionId:'session', event:'message.received',
  data:{ id:'m1',from:'12345678901@c.us',type:'document',media },
})
describe('OpenWA signed inline media extraction', () => {
  it('extracts small inline data only from its media descriptor', () => {
    expect(extractOpenWASignedInlineMedia(envelope({ mimetype:'application/pdf',data:'YWJj' }))).toBe('YWJj')
  })
  it('never extracts unbounded media or arbitrary message body', () => {
    expect(extractOpenWASignedInlineMedia(envelope({data:'a'.repeat(Math.ceil(MEDIA_MAX_BYTES*4/3)+8)}))).toBeUndefined()
    expect(extractOpenWASignedInlineMedia(envelope({omitted:true,sizeBytes:25_000_000}))).toBeUndefined()
    expect(extractOpenWASignedInlineMedia({ ...envelope({}),data:{body:'YWJj'} })).toBeUndefined()
  })
})
