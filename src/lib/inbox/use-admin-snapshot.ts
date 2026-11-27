'use client'
import {useEffect,useState} from 'react'
import {fetchInbox,type InboxContext} from './scoped-list-model'

// Administrative dialogs must not inherit the conversation polling revision.
// Retain a same-query snapshot during an explicit refresh, but never render
// one from another account, actor, tab or cursor. Failed reads clear data
// (including authorization loss); server-side mutation checks remain authoritative.
export type AdminSnapshot<T>={scopeKey:string;requestKey:string;page:T|null;error:boolean}
export function adminSnapshotKeys(ctx:InboxContext,path:string,revision:number){
 const scopeKey=JSON.stringify([ctx.accountId,ctx.userId,path])
 return {scopeKey,requestKey:JSON.stringify([scopeKey,revision])}
}
export function adminSnapshotView<T>(snapshot:AdminSnapshot<T>|null,scopeKey:string,requestKey:string,active:boolean){
 const current=active&&snapshot?.scopeKey===scopeKey?snapshot:null
 const settled=current?.requestKey===requestKey
 return {page:current?.page??null,refreshing:active&&!settled,error:active&&settled&&current?.error===true}
}
export function useAdminSnapshot<T>(ctx:InboxContext,active:boolean,path:string,revision:number,normalize:(raw:unknown)=>T|null){
 const {accountId,userId}=ctx
 const {scopeKey,requestKey}=adminSnapshotKeys(ctx,path,revision)
 const [snapshot,setSnapshot]=useState<AdminSnapshot<T>|null>(null)
 useEffect(()=>{
  if(!active)return
  const ctl=new AbortController()
  void fetchInbox<unknown>(path,{accountId,userId},ctl.signal)
   .then(raw=>{
    const page=normalize(raw)
    if(!page)throw Error('invalid administrative snapshot')
    if(!ctl.signal.aborted)setSnapshot({scopeKey,requestKey,page,error:false})
   })
   .catch(()=>{if(!ctl.signal.aborted)setSnapshot({scopeKey,requestKey,page:null,error:true})})
  return()=>ctl.abort()
 },[active,path,accountId,userId,scopeKey,requestKey,normalize])
 return adminSnapshotView(snapshot,scopeKey,requestKey,active)
}
