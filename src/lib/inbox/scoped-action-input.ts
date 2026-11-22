import {validateInteractivePayload,type InteractiveMessagePayload} from '@/lib/whatsapp/interactive'
import type {WhatsAppTemplateSendParams} from '@/lib/whatsapp/transport/types'
import type {SendMessageParams} from '@/lib/whatsapp/send-message'
import {safeInboxMedia} from './read-api'
import {parseActionScope,type ActionScope} from './action-intent-model'
import {validId} from './scoped-list-model'
export type ScopedActionInput={scope:ActionScope;key:string;kind:'send';params:SendMessageParams}|{scope:ActionScope;key:string;kind:'provider_read';messageId:string}|{scope:ActionScope;key:string;kind:'reaction';messageId:string;emoji:string}
type Obj=Record<string,unknown>
const obj=(x:unknown):x is Obj=>!!x&&typeof x==='object'&&!Array.isArray(x)
const keys=(x:Obj,allowed:string[])=>Object.keys(x).every(k=>allowed.includes(k))
const str=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length<=max
const opt=(x:unknown,max:number)=>x===undefined||x===null||str(x,max)
const arr=(x:unknown,max=30):x is string[]=>Array.isArray(x)&&x.length<=max&&x.every(v=>str(v,1024))
const bad=():never=>{throw Error('Invalid scoped action request')}
export function parseScopedAction(body:unknown,threadId:string,accountId:string):ScopedActionInput{
 if(!obj(body)||!validId(body.key))return bad()
 const scope=parseActionScope(body.scope),key=body.key.toLowerCase()
 if(!scope||scope.threadId!==threadId.toLowerCase())return bad()
 if(body.action==='provider_read'||body.action==='reaction'){
  if(!validId(body.messageId)||!keys(body,body.action==='reaction'?['scope','key','action','messageId','emoji']:['scope','key','action','messageId']))return bad()
  if(body.action==='reaction'){
   if(scope.provider!=='meta_cloud'||!str(body.emoji,32)||body.emoji!==''&&!/\p{Extended_Pictographic}/u.test(body.emoji))return bad()
   return {scope,key,kind:'reaction',messageId:body.messageId.toLowerCase(),emoji:body.emoji}
  }
  return {scope,key,kind:'provider_read',messageId:body.messageId.toLowerCase()}
 }
 if(body.action!=='send'||!obj(body.payload)||!keys(body,['scope','key','action','payload']))return bad()
 const p=body.payload
 if(!keys(p,['messageType','contentText','mediaUrl','filename','templateName','templateLanguage','templateParams','templateMessageParams','interactivePayload','replyToMessageId'])||!str(p.messageType,20)||!opt(p.contentText,4096)||!opt(p.filename,255)||!opt(p.mediaUrl,2048)||!opt(p.templateName,512)||!opt(p.templateLanguage,32)||(p.replyToMessageId!=null&&!validId(p.replyToMessageId)))return bad()
 const kind=p.messageType,media=['image','video','audio','document'].includes(kind)
 if(!media&&!['text','template','interactive'].includes(kind))return bad()
 if(scope.provider==='openwa'&&['template','interactive'].includes(kind))return bad()
 if(kind==='text'&&(!str(p.contentText,4096)||!p.contentText.trim()))return bad()
 if(media&&(!safeInboxMedia(p.mediaUrl,accountId)||p.contentText!=null&&String(p.contentText).length>1024))return bad()
 if(!media&&(p.mediaUrl!=null||p.filename!=null))return bad()
 if(kind==='interactive'&&!validateInteractivePayload(p.interactivePayload).ok)return bad()
 if(kind!=='interactive'&&p.interactivePayload!=null)return bad()
 if(kind==='template'&&(!str(p.templateName,512)||!p.templateName.trim()||!str(p.templateLanguage,32)||!p.templateLanguage.trim()))return bad()
 if(kind!=='template'&&[p.templateName,p.templateLanguage,p.templateParams,p.templateMessageParams].some(v=>v!=null))return bad()
 if(p.templateParams!=null&&!arr(p.templateParams))return bad()
 let templateMessageParams:WhatsAppTemplateSendParams|undefined
 if(p.templateMessageParams!=null){
  const m=p.templateMessageParams
  if(!obj(m)||!keys(m,['body','headerText','headerMediaUrl','buttonParams'])||m.body!=null&&!arr(m.body)||!opt(m.headerText,1024)||m.headerMediaUrl!=null&&!safeInboxMedia(m.headerMediaUrl,accountId)||m.buttonParams!=null&&(!obj(m.buttonParams)||Object.keys(m.buttonParams).length>10||Object.entries(m.buttonParams).some(([k,v])=>!/^[0-9]$/.test(k)||!str(v,1024))))return bad()
  templateMessageParams=m as unknown as WhatsAppTemplateSendParams
 }
 return {scope,key,kind:'send',params:{conversationId:'',messageType:kind,contentText:p.contentText as string|null|undefined,mediaUrl:p.mediaUrl as string|null|undefined,filename:p.filename as string|null|undefined,templateName:p.templateName as string|null|undefined,templateLanguage:p.templateLanguage as string|null|undefined,templateParams:p.templateParams as string[]|undefined,templateMessageParams,interactivePayload:p.interactivePayload as InteractiveMessagePayload|null|undefined,replyToMessageId:p.replyToMessageId?String(p.replyToMessageId).toLowerCase():null}}
}
