import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source=(file:string)=>readFileSync(process.cwd()+'/'+file,'utf8')

describe('Inbox verified channel onboarding is admin-only, explicit and safe',()=>{
 it('uses the existing TEST-only server verification route without sending or guessing identity',()=>{
   const widget=source('src/components/inbox/scoped-verify-channel.tsx')
   const workspace=source('src/components/inbox/scoped-inbox.tsx')
   const endpoint=source('src/app/api/inbox/connections/[connectionId]/verify-channel/route.ts')
   expect(widget).toContain("useCan('edit-settings')")
   expect(widget).toContain("method: 'POST'")
   expect(widget).toContain("JSON.stringify({ makePrimary })")
   expect(widget).toContain("verify(false)")
   expect(widget).toContain("verify(true)")
   expect(widget).toContain("x-wacrm-inbox-account")
   expect(endpoint).toContain("x-wacrm-inbox-actor")
   expect(widget).not.toContain('/api/whatsapp/send')
   expect(widget).not.toContain('phone_identity')
   expect(workspace).toContain("c.registry_online&&!c.archived&&(c.identity_state==='unverified'||c.provider==='openwa')")
   expect(endpoint).toContain("process.env.WACRM_INBOX_SHADOW_ENROLLMENT !== 'true'")
   expect(endpoint).toContain('requireOpenWASessionAdmin()')
   expect(endpoint).toContain('enrollVerifiedInboxChannel')
 })
 it('offers localized verify, error and success states across locales',()=>{
   for(const locale of ['ar','en','ko']){
     const dictionary=JSON.parse(source('messages/'+locale+'.json')) as {Inbox:{scoped:Record<string,string>}}
     for(const key of ['verifyChannel','verifyingChannel','verifyChannelSuccess','verifyChannelFailed','nativeEnrollPrimary','nativeEnrollExplanation','nativeEnrollmentSuccess','nativeEngineUnverified','nativeVersionUnsupported','nativeEngineUnsupported','nativeSessionNotLive','nativeWebhookUnconfigured','nativeHandoverBlocked','nativeEnrollmentFailed'])
       expect(dictionary.Inbox.scoped[key],locale+':'+key).toBeTruthy()
   }
 })
})
