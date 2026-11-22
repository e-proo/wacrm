import type {ActionScope} from './action-intent-model'
import type {InboxContext} from './scoped-list-model'
import {validId} from './scoped-list-model'

// The caller creates the UUID once on an explicit gesture and freezes it
// across a network timeout. A GET reconciles that exact key; there is never
// an automatic second POST or a silent sender substitution.
export type ScopedActionRequest=
 | {scope:ActionScope;key:string;action:'send';payload:{messageType:string;contentText?:string;mediaUrl?:string;filename?:string;templateName?:string;templateLanguage?:string;templateParams?:string[];templateMessageParams?:unknown;interactivePayload?:unknown;replyToMessageId?:string|null}}
 | {scope:ActionScope;key:string;action:'provider_read';messageId:string}
 | {scope:ActionScope;key:string;action:'reaction';messageId:string;emoji:string}
export type ScopedActionOutcome={state:'accepted'|'pending'|'blocked'|'uncertain'|'denied'|'unconfirmed';code?:string;intent_id?:string;message_id?:string|null;replayed?:boolean}
export class ScopedActionTransportUnknown extends Error{
 constructor(){super('Action outcome not confirmed; check the original request key before any new action');this.name='ScopedActionTransportUnknown'}
}
function headers(ctx:InboxContext){
 return {'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId}
}
function parseOutcome(v:unknown):ScopedActionOutcome {
 if(!v||typeof v!=='object')throw new ScopedActionTransportUnknown()
 const o=v as ScopedActionOutcome
 if(!['accepted','pending','blocked','uncertain','denied','unconfirmed'].includes(o.state))throw new ScopedActionTransportUnknown()
 return o
}
export async function submitScopedAction(ctx:InboxContext,request:ScopedActionRequest):Promise<ScopedActionOutcome>{
 if(!validId(request.key)||!validId(request.scope.threadId))throw new Error('Invalid scoped action identity')
 let response:Response
 try {
  response=await fetch('/api/inbox/threads/'+request.scope.threadId+'/actions',{
   method:'POST',credentials:'same-origin',cache:'no-store',headers:headers(ctx),body:JSON.stringify(request),
  })
 }catch{throw new ScopedActionTransportUnknown()}
 let json:unknown
 try{json=await response.json()}catch{throw new ScopedActionTransportUnknown()}
 // 409 for a recorded ambiguous outcome is not a transport failure.
 return parseOutcome(json)
}
export async function inspectScopedAction(ctx:InboxContext,threadId:string,key:string):Promise<ScopedActionOutcome>{
 if(!validId(key)||!validId(threadId))throw new Error('Invalid scoped action identity')
 let response:Response
 try{response=await fetch('/api/inbox/threads/'+threadId+'/actions?key='+encodeURIComponent(key),{method:'GET',credentials:'same-origin',cache:'no-store',headers:headers(ctx)})}
 catch{throw new ScopedActionTransportUnknown()}
 let json:unknown
 try{json=await response.json()}catch{throw new ScopedActionTransportUnknown()}
 return parseOutcome(json)
}
