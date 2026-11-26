import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
const source=(p:string)=>readFileSync(process.cwd()+'/'+p,'utf8')
describe('FIX-03 review UI boundary',()=>{
 it('uses the dedicated administration endpoint with explicit maintenance and stable request key',()=>{
  const ui=source('src/components/inbox/scoped-intake-review.tsx')
  expect(ui).toContain("useCan('edit-settings')")
  expect(ui).toContain('confirmMaintenance:true')
  expect(ui).toContain('requestId:key')
  expect(ui).toContain('disabled={!checked||busy}')
  expect(ui).toContain('x-wacrm-inbox-account')
  expect(ui).not.toContain('/api/whatsapp/send')
  expect(ui).not.toContain('dangerouslySetInnerHTML')
  expect(source('src/components/inbox/scoped-inbox.tsx')).toContain('<ScopedIntakeReview ctx={ctx}')
 })
 it('has translations in all supported locales',()=>{
  for(const locale of ['ar','en','ko']){
   const d=JSON.parse(source('messages/'+locale+'.json')) as {Inbox:{scoped:Record<string,string>}}
   for(const k of ["reviewTitle","reviewDescription","reviewPending","reviewClosed","reviewMissingEpoch","reviewEventOnly","reviewMissingNamespace","reviewPeerConflict","reviewReceiptConflict","reviewLegacyCollision","reviewEchoUnproven","reviewReactionUnproven","reviewSourceUnconfirmed","reviewPayloadChanged","reviewPrimaryUnavailable","reviewBusy","reviewUnverified","reviewDuplicateEligible","reviewRestoreEligible","reviewRestored","reviewDuplicateConfirmed","reviewClosedUnverified","reviewSystemResolved","reviewRestore","reviewSettleDuplicate","reviewCloseUnverified","reviewRestoreNotice","reviewDuplicateNotice","reviewCloseNotice","reviewReceivedAt","reviewResolvedAt","reviewKind","reviewPreview","reviewNoProofNotice","reviewMaintenanceConfirm","reviewConfirm","reviewConflict","reviewFailed","reviewLoadFailed","reviewMaintenanceRequired","reviewEmptyPending","reviewEmptyClosed"])expect(d.Inbox.scoped[k],locale+':'+k).toBeTruthy()
  }
 })
})
