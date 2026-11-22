import {afterEach,describe,expect,it,vi} from 'vitest'
import {inspectScopedAction,submitScopedAction,ScopedActionTransportUnknown} from './scoped-action-client'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const ctx={accountId:id(1),userId:id(2)}
const scope={threadId:id(3),channelId:id(4),connectionId:id(5),membershipId:id(6),provider:'openwa' as const}
afterEach(()=>vi.unstubAllGlobals())
describe('exact scoped action client boundary',()=>{
 it('submits the identical frozen request key, explicit sender and verified scope',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({state:'accepted',message_id:id(7)}),{status:200,headers:{'content-type':'application/json'}}))
  vi.stubGlobal('fetch',fetcher)
  const request={scope,key:id(8),action:'send' as const,payload:{messageType:'text',contentText:'test'}}
  const result=await submitScopedAction(ctx,request)
  expect(result.state).toBe('accepted')
  const [,args]=fetcher.mock.calls[0]
  expect(JSON.parse(args.body)).toEqual(request)
  expect(args.headers['x-wacrm-inbox-account']).toBe(ctx.accountId)
  expect(args.method).toBe('POST')
 })
 it('preserves the original key on network uncertainty and queries status without resending',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({state:'pending'}),{status:200}))
  vi.stubGlobal('fetch',fetcher)
  await expect(submitScopedAction(ctx,{scope,key:id(8),action:'provider_read',messageId:id(7)})).rejects.toBeInstanceOf(ScopedActionTransportUnknown)
  expect((await inspectScopedAction(ctx,scope.threadId,id(8))).state).toBe('pending')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][1].method).toBe('GET')
 })
 it('reports recorded 409 uncertain, never treating it as a retry invitation',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({state:'uncertain',code:'reconciliation_required'}),{status:409})))
  expect((await submitScopedAction(ctx,{scope,key:id(8),action:'reaction',messageId:id(7),emoji:'👍'})).state).toBe('uncertain')
 })
})
