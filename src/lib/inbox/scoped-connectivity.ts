
'use client'
import {useEffect,useState} from 'react'
import type {ScopedRealtimeStatus} from './use-scoped-realtime'

// Connectivity of the browser and the Supabase realtime channel is NOT
// WhatsApp provider/session readiness and must be labelled separately.
export type ScopedConnectivityNotice='browser_offline'|'realtime_reconnecting'|null
export function scopedConnectivityNotice(browserOnline:boolean,realtime:ScopedRealtimeStatus):ScopedConnectivityNotice {
 return !browserOnline?'browser_offline':realtime==='reconnecting'?'realtime_reconnecting':null
}
export function useBrowserOnline(){
 const [online,setOnline]=useState(true)
 useEffect(()=>{
  const update=()=>setOnline(navigator.onLine)
  window.addEventListener('online',update);window.addEventListener('offline',update)
  return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update)}
 },[])
 return online
}
