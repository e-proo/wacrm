'use client'
import { useEffect,useRef,useState } from 'react'
import { fetchInbox,mergePage,pagePath,type InboxContext,type Page } from './scoped-list-model'
type Snapshot<T>={key:string;items:T[];cursor:string|null;busy:boolean;error:boolean}
export function useInboxPages<T extends {id:string}>(path:string,ctx:InboxContext,validate?:(row:T)=>boolean){
 const key=ctx.accountId+':'+ctx.userId+':'+path
 const [snapshot,setSnapshot]=useState<Snapshot<T>>({key,items:[],cursor:null,busy:true,error:false})
 const current=useRef<{controller:AbortController;pending:boolean}|null>(null)
 const validator=useRef(validate)
 useEffect(()=>{validator.current=validate},[validate])
 useEffect(()=>{
  const job={controller:new AbortController(),pending:true}
  current.current=job
  void fetchInbox<Page<T>>(path,{accountId:ctx.accountId,userId:ctx.userId},job.controller.signal).then(body=>{
   if(job.controller.signal.aborted)return
   if(!Array.isArray(body.items)||body.items.some(x=>!x||typeof x.id!=='string'||(validator.current&&!validator.current(x))))throw new Error('Invalid page scope')
   setSnapshot({key,items:mergePage([],body.items),cursor:body.next_cursor,busy:false,error:false})
  }).catch(()=>{if(!job.controller.signal.aborted)setSnapshot({key,items:[],cursor:null,busy:false,error:true})}).finally(()=>{job.pending=false})
  return ()=>{job.controller.abort();if(current.current===job)current.current=null}
 },[path,key,ctx.accountId,ctx.userId])
 const visible=snapshot.key===key?snapshot:{key,items:[],cursor:null,busy:true,error:false}
 function more(){
  const job=current.current
  if(!job||job.pending||!visible.cursor||visible.busy)return
  job.pending=true
  const cursor=visible.cursor
  setSnapshot(s=>s.key===key?{...s,busy:true,error:false}:s)
  void fetchInbox<Page<T>>(pagePath(path,cursor),ctx,job.controller.signal).then(body=>{
   if(job.controller.signal.aborted)return
   if(!Array.isArray(body.items)||body.items.some(x=>!x||typeof x.id!=='string'||(validator.current&&!validator.current(x)))||body.next_cursor===cursor)throw new Error('Invalid page scope')
   setSnapshot(s=>s.key===key?{key,items:mergePage(s.items,body.items),cursor:body.next_cursor,busy:false,error:false}:s)
  }).catch(()=>{if(!job.controller.signal.aborted)setSnapshot(s=>s.key===key?{...s,busy:false,error:true}:s)}).finally(()=>{job.pending=false})
 }
 return {...visible,more}
}
export function useInboxCounts<T>(path:string,ctx:InboxContext){
 const key=ctx.accountId+':'+ctx.userId+':'+path
 const [state,setState]=useState<{key:string;value:T|null;error:boolean}>({key,value:null,error:false})
 useEffect(()=>{
  const controller=new AbortController()
  void fetchInbox<{counts:T}>(path,{accountId:ctx.accountId,userId:ctx.userId},controller.signal).then(b=>{if(!controller.signal.aborted)setState({key,value:b.counts,error:false})}).catch(()=>{if(!controller.signal.aborted)setState({key,value:null,error:true})})
  return ()=>controller.abort()
 },[path,key,ctx.accountId,ctx.userId])
 return state.key===key?state:{key,value:null,error:false}
}
