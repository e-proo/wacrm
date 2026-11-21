import { describe,it,expect,vi } from 'vitest'
import { canAcknowledge,historyPath,historyKey,validateHistory,mergeHistory,submitScopedRead,type HistoryScope,type HistoryPage,type HistoryMessage } from './scoped-history-model'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333',d='44444444-4444-4444-8444-444444444444'
const row:HistoryScope={id:c,conversation_id:b,scope:'active',channel_id:d,provider:'openwa'}
const ctx={accountId:a,userId:b}
const message:HistoryMessage={id:a,conversation_id:b,channel_id:d,provider:'openwa',sender_type:'customer',content_type:'text',content_text:'hello',media_type:null,media_url:null,has_media:false,status:'delivered',created_at:null,ingest_sequence:'1',reply_to_message_id:null,reactions:[]}
const page:HistoryPage={items:[message],next_cursor:null,read_only:true,scope:'active',channel_id:d,conversation_id:b,observed_highwater:'1',read_watermark:'0',read_token:'token'}
describe('canonical scoped history',()=>{
 it('binds exact API path and account actor scope and rejects sibling or wrong lane responses',()=>{
  expect(historyPath(row)).toContain('threads/'+c+'/messages?scope=active')
  expect(historyPath(row)).toContain('channel_id='+d)
  expect(historyPath({...row,scope:'unknown',channel_id:null,provider:null})).toContain('unknown/'+b+'/messages')
  expect(historyKey(row,ctx)).not.toBe(historyKey(row,{...ctx,userId:d}))
  expect(validateHistory(page,row)).toBe(true)
  expect(validateHistory({...page,items:[{...message,channel_id:a}]},row)).toBe(false)
  expect(validateHistory({...page,scope:'historical'},row)).toBe(false)
  expect(mergeHistory([message],[{...message,status:'read'}])).toEqual([{...message,status:'read'}])
 })
 it('never allows a read on a hidden tab, stale URL, legacy or historical lane',()=>{
  const q='scope=active&c='+b+'&thread='+c+'&channel='+d
  expect(canAcknowledge(row,q,true,true,'token')).toBe(true)
  expect(canAcknowledge(row,q,false,true,'token')).toBe(false)
  expect(canAcknowledge(row,q,true,false,'token')).toBe(false)
  expect(canAcknowledge(row,q.replace(c,a),true,true,'token')).toBe(false)
  expect(canAcknowledge(row,q.replace(d,a),true,true,'token')).toBe(false)
  expect(canAcknowledge(row,'c='+b,true,true,'token')).toBe(false)
  expect(canAcknowledge({...row,scope:'historical'},q,true,true,'token')).toBe(false)
  expect(canAcknowledge(row,q,true,true,null)).toBe(false)
 })
 it('rejects a late acknowledgement when the selection is cancelled',async()=>{
  let finish!:(r:Response)=>void
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>finish=r)))
  try{const controller=new AbortController(),pending=submitScopedRead(row,ctx,'token',controller.signal);controller.abort();finish(Response.json({thread_id:c,channel_id:d}));await expect(pending).rejects.toThrow()}finally{vi.unstubAllGlobals()}
 })
})
