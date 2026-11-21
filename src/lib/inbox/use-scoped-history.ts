'use client'
import { useEffect,useRef,useState } from 'react'
import { fetchInbox,pagePath,type InboxContext } from './scoped-list-model'
import { historyKey,historyPath,mergeHistory,validateHistory,type HistoryMessage,type HistoryPage,type HistoryScope } from './scoped-history-model'

type State={key:string;items:HistoryMessage[];cursor:string|null;token:string|null;busy:boolean;error:boolean}
type Session={key:string;controller:AbortController;reload:()=>void;more:()=>void}
const empty=(key:string):State=>({key,items:[],cursor:null,token:null,busy:true,error:false})
export function useScopedHistory(row:HistoryScope,ctx:InboxContext,revision:number,beforeChange:()=>void){
 const key=historyKey(row,ctx),path=historyPath(row)
 const accountId=ctx.accountId,userId=ctx.userId,scope=row.scope,channel=row.channel_id,parent=row.conversation_id,provider=row.provider,thread=row.id
 const [state,setState]=useState<State>(()=>empty(key))
 const current=useRef<Session|null>(null),before=useRef(beforeChange)
 useEffect(()=>{before.current=beforeChange},[beforeChange])
 useEffect(()=>{
  const controller=new AbortController(),{signal}=controller
  const expected:HistoryScope={id:thread,conversation_id:parent,scope,channel_id:channel,provider}
  let snapshot=empty(key),depth=1,pending=false,queued=false
  const commit=(next:State)=>{
   if(signal.aborted)return
   before.current()
   snapshot=next
   setState(next)
  }
  async function page(cursor:string|null){
   const result=await fetchInbox<HistoryPage>(pagePath(path,cursor),{accountId,userId},signal)
   if(!validateHistory(result,expected)||cursor!==null&&cursor===result.next_cursor)throw new Error('Invalid history page')
   return result
  }
  async function load(append:boolean){
   if(signal.aborted)return
   if(pending){if(!append)queued=true;return}
   if(append&&!snapshot.cursor)return
   pending=true
   if(append)commit({...snapshot,busy:true,error:false})
   try{
    if(append){
     const result=await page(snapshot.cursor)
     depth+=1
     commit({...snapshot,items:mergeHistory(snapshot.items,result.items),cursor:result.next_cursor,busy:false,error:false})
    }else{
     // Rebuild the loaded window, including deletes and edits, rather than
     // merging an older snapshot into the new canonical transcript.
     let items:HistoryMessage[]=[],cursor:string|null=null,token:string|null=null,loaded=0
     for(let i=0;i<depth;i++){
      const result=await page(cursor)
      if(i===0)token=typeof result.read_token==='string'?result.read_token:null
      items=mergeHistory(items,result.items);cursor=result.next_cursor;loaded++
      if(!cursor)break
     }
     depth=loaded
     commit({key,items,cursor,token,busy:false,error:false})
    }
   }catch{
    if(!signal.aborted){depth=1;commit({...empty(key),busy:false,error:true})}
   }finally{
    pending=false
    if(queued&&!signal.aborted){queued=false;void load(false)}
   }
  }
  const session:Session={key,controller,reload:()=>{void load(false)},more:()=>{void load(true)}}
  current.current=session
  return ()=>{controller.abort();if(current.current===session)current.current=null}
 },[key,path,accountId,userId,scope,channel,parent,provider,thread])
 useEffect(()=>{const session=current.current;if(session?.key===key)session.reload()},[key,revision])
 const visible=state.key===key?state:empty(key)
 return {...visible,more:()=>{if(current.current?.key===key)current.current.more()},retry:()=>{if(current.current?.key===key)current.current.reload()}}
}
