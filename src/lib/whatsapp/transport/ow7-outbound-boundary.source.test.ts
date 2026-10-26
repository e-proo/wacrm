import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const raw=fs.readFileSync(path.join(process.cwd(),'src/lib/whatsapp/send-message.ts'),'utf8');const source=raw.replace(/\s+/g,'')
describe('OW-7/OW-8 shared outbound safety boundary',()=>{
 it('routes by provider-neutral conversation connection and reserves idempotency before provider send',()=>{expect(raw).toContain('resolveConversationTransport');expect(source).toContain('outbound_idempotency_key:sendKey');expect(source.indexOf(".from('messages').insert")).toBeLessThan(source.indexOf('resolved.transport.send'))})
 it('fails closed on cross-connection/provider replies and preserves ambiguous outcomes',()=>{expect(raw).toContain('Reply target belongs to a different WhatsApp connection');expect(raw).toContain('Reply target belongs to a different WhatsApp provider');expect(source).toContain("transportError?.code!=='ambiguous_outcome'");expect(raw).toContain('already pending reconciliation')})
 it('does not apply Meta approved-template or interactive semantics to OpenWA while allowing OW-8 media',()=>{expect(raw).toContain('OpenWA does not use Meta approved-template policy');expect(source).toContain("content.kind==='template'||content.kind==='interactive'");expect(source).toContain("kind:'media'")})
})
