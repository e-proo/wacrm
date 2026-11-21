'use client'
import { useEffect,useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { InboxContext } from './scoped-list-model'

// Realtime is an invalidation hint, NEVER a message/list payload. Exact
// server snapshots remain authoritative for ordering, deletes and counts.
export function useScopedInboxRealtime({accountId,userId}:InboxContext,onInvalidate:()=>void){
 const callback=useRef(onInvalidate)
 useEffect(()=>{callback.current=onInvalidate},[onInvalidate])
 useEffect(()=>{
  const client=createClient()
  let timer:ReturnType<typeof setTimeout>|null=null,closed=false
  function wake(){
   if(closed||document.visibilityState!=='visible'||timer!==null)return
   timer=setTimeout(()=>{timer=null;if(!closed&&document.visibilityState==='visible')callback.current()},350)
  }
  const filter='account_id=eq.'+accountId
  const channel=client.channel('scoped-inbox:'+accountId+':'+userId)
   .on('postgres_changes',{event:'INSERT',schema:'public',table:'inbox_thread_changes',filter},wake)
   .on('postgres_changes',{event:'UPDATE',schema:'public',table:'inbox_thread_changes',filter},wake)
   .on('postgres_changes',{event:'INSERT',schema:'public',table:'conversations',filter},wake)
   .on('postgres_changes',{event:'UPDATE',schema:'public',table:'conversations',filter},wake)
   .subscribe(status=>{if(status==='SUBSCRIBED'||status==='CHANNEL_ERROR'||status==='TIMED_OUT')wake()})
  // Recovery covers events lost during disconnect, DELETE, readiness changes
  // and unknown-lane reactions. No reads are acknowledged by these refreshes.
  const poll=setInterval(wake,20_000)
  document.addEventListener('visibilitychange',wake)
  window.addEventListener('online',wake)
  window.addEventListener('focus',wake)
  return ()=>{
   closed=true
   if(timer!==null)clearTimeout(timer)
   clearInterval(poll)
   document.removeEventListener('visibilitychange',wake)
   window.removeEventListener('online',wake)
   window.removeEventListener('focus',wake)
   void client.removeChannel(channel)
  }
 },[accountId,userId])
}
