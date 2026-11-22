
'use client'
import {useSyncExternalStore} from 'react'
import type {ScopedRealtimeStatus} from './use-scoped-realtime'

// Connectivity of the browser and the Supabase realtime channel is NOT
// WhatsApp provider/session readiness and must be labelled separately.
export type ScopedConnectivityNotice='browser_offline'|'realtime_reconnecting'|null
export function scopedConnectivityNotice(browserOnline:boolean,realtime:ScopedRealtimeStatus):ScopedConnectivityNotice {
 return !browserOnline?'browser_offline':realtime==='reconnecting'?'realtime_reconnecting':null
}
function subscribeBrowserOnline(listener:()=>void){
 window.addEventListener('online',listener)
 window.addEventListener('offline',listener)
 return()=>{window.removeEventListener('online',listener);window.removeEventListener('offline',listener)}
}
function browserOnlineSnapshot(){return typeof navigator==='undefined'?true:navigator.onLine}
export function useBrowserOnline(){
 // Server snapshot remains deterministic; React checks the true client state
 // immediately after hydration even when the browser starts offline.
 return useSyncExternalStore(subscribeBrowserOnline,browserOnlineSnapshot,()=>true)
}
