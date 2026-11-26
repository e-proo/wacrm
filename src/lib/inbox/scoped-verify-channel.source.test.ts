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
   const readiness=source('src/components/inbox/scoped-channel-readiness.tsx')
   expect(workspace).toContain('<ScopedChannelReadiness ctx={ctx}')
   expect(readiness).toContain('identityUnverified={caps.verifyIdentity} openwa={caps.verifyPrimary}')
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

describe('FIX-02 central readiness console',()=>{
 it('exposes all supported locales and explicit maintenance confirmation',()=>{
  const consoleSource=source('src/components/inbox/scoped-channel-readiness.tsx')
  expect(consoleSource).toContain("useCan('edit-settings')")
  expect(consoleSource).toContain('confirmMaintenance:true')
  expect(consoleSource).toContain('disabled={!maintenance||busy}')
  expect(consoleSource).not.toContain('/api/whatsapp/send')
  for(const locale of ['ar','en','ko']){
   const dictionary=JSON.parse(source('messages/'+locale+'.json')) as {Inbox:{scoped:Record<string,string>}}
   for(const key of ["readinessTitle","readinessDescription","readinessSnapshotNotice","readinessRefresh","readinessUpdated","readinessRevoked","readinessLoadFailed","readinessRuntime","readinessShadowOn","readinessShadowOff","readinessCanonicalOn","readinessCanonicalOff","readinessActionsOn","readinessActionsOff","readinessGateNotice","readinessNeedsAttention","readinessConfigured","readinessMetaVerified","readinessNamespaceVerified","readinessNamespaceMissing","readinessPrimaryMissing","readinessWebhookConfigured","readinessNoWebhook","readinessEngine","readinessVersion","readinessHeld","readinessIdentityAt","readinessProofAt","readinessClosedAt","readinessReasons","readinessOffline","readinessNoCandidate","readinessNoCredentials","readinessIdentityMissing","readinessSharedUnverified","readinessHandoverBlocked","readinessContractMismatch","readinessHandoverNotice","readinessHeldNotice","readinessMaintenanceRequired","readinessRevoke","readinessRevokeNotice","readinessMaintenanceConfirm","readinessConfirmRevoke","readinessRevokeBusy","readinessRevokeConflict","readinessRevokeFailed","readinessPages","readinessPrevious","readinessNext"]) expect(dictionary.Inbox.scoped[key],locale+':'+key).toBeTruthy()
  }
 })
})
