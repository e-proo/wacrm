import { createHash } from 'node:crypto'
import { validId } from './scoped-list-model'

export type ActionScope={threadId:string;channelId:string;connectionId:string;membershipId:string;provider:'meta_cloud'|'openwa'}
export type IntentState='claimed'|'pending'|'accepted'|'blocked'|'uncertain'|'conflict'|'denied'
export type IntentResult={state:IntentState;intent_id?:string;message_id?:string|null}
export function parseActionScope(value:unknown):ActionScope|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const s=value as Record<string,unknown>
 if(Object.keys(s).length!==5||![s.threadId,s.channelId,s.connectionId,s.membershipId].every(validId)||!['meta_cloud','openwa'].includes(String(s.provider)))return null
 return {threadId:String(s.threadId).toLowerCase(),channelId:String(s.channelId).toLowerCase(),connectionId:String(s.connectionId).toLowerCase(),membershipId:String(s.membershipId).toLowerCase(),provider:s.provider as ActionScope['provider']}
}
// Canonicalize JSON object keys without changing arrays. Never persist raw
// payloads, native identifiers, tokens or credentials in the admission journal.
function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical)
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]))
 return value
}
export function actionFingerprint(scope:ActionScope,kind:string,recipient:string,payload:unknown):string{
 return createHash('sha256').update('wacrm-inbox-action:v1\0'+JSON.stringify(canonical({scope,kind,recipient,payload}))).digest('hex')
}
export function decodeIntent(value:unknown):IntentResult {
 if(!value||typeof value!=='object')throw Error('Action admission unavailable')
 const v=value as IntentResult
 if(!['claimed','pending','accepted','blocked','uncertain','conflict','denied'].includes(v.state)||!['conflict','denied'].includes(v.state)&&!validId(v.intent_id)||v.message_id!=null&&!validId(v.message_id))throw Error('Action admission unavailable')
 return v
}
