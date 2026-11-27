import type {InboxCapabilities} from './provider-policy-model'

// Preview only. Every actual action must still pass the server admission gate.
export const POLICY_REFRESH_INTERVAL_MS=10_000
export const POLICY_PREVIEW_MAX_AGE_MS=60_000
export type PolicySnapshot={key:string;capabilities:InboxCapabilities;seen:number}
export function freshPolicy(snapshot:PolicySnapshot|null,key:string,now:number,online:boolean):PolicySnapshot|null{
 return online&&snapshot?.key===key&&Number.isFinite(now)&&Math.max(now,snapshot.seen)-snapshot.seen<POLICY_PREVIEW_MAX_AGE_MS?snapshot:null
}
export function policyScopeKey(account:string,actor:string,thread:string,channel:string|null,provider:string|null,connection:string|null,conversation:string,online:boolean){
 return JSON.stringify([account,actor,thread,channel,provider,connection,conversation,online])
}

// One request per scope at a time; invalidations coalesce instead of
// aborting an in-flight policy read whenever the transcript changes.
export function createPolicyRefreshQueue(load:()=>Promise<void>,now=Date.now,interval=POLICY_REFRESH_INTERVAL_MS){
 let timer:ReturnType<typeof setTimeout>|null=null,running=false,queued=false,urgent=false,disposed=false,lastStart=-Infinity
 function schedule(){
  if(disposed||running||!queued)return
  const delay=urgent?0:Math.max(0,lastStart+interval-now())
  if(timer!==null){if(delay>0)return;clearTimeout(timer);timer=null}
  if(delay>0){timer=setTimeout(()=>{timer=null;schedule()},delay);return}
  queued=false;urgent=false;running=true;lastStart=now()
  void (async()=>{try{await load()}catch{/* Caller handles its own safe failure state. */}finally{running=false;schedule()}})()
 }
 return {
  wake(force=false){if(disposed)return;queued=true;urgent=urgent||force;schedule()},
  dispose(){disposed=true;queued=false;if(timer!==null){clearTimeout(timer);timer=null}}
 }
}
