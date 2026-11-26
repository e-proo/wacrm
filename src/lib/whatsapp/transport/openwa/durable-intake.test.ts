import {beforeEach,describe,expect,it,vi} from 'vitest'
vi.mock('@/lib/whatsapp/encryption',()=>({encrypt:(value:string)=>'iv:'+Buffer.from(value).toString('hex')+':tag',decrypt:(value:string)=>Buffer.from(value.split(':')[1],'hex').toString('utf8')}))
import {durableOpenWAIntakeEnabled,enqueueVerifiedIntake,intakeDigest,sealIntake,openIntake,readDurableWebhookBody,MAX_DURABLE_BODY_BYTES,readIntakeClaim,type IntakeClaim} from './durable-intake'
const account='11111111-1111-4111-8111-111111111111',connection='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',token='44444444-4444-4444-8444-444444444444'
const binding={accountId:account,connectionId:connection}
const envelope={eventId:'evt',sessionId:'fixture',timestamp:'2026-11-26T14:00:00Z',event:'message',data:{text:'private fixture',media:{data:'aGVsbG8='}}}
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://pqirsnfupofhulmewakq.supabase.co');vi.stubEnv('WACRM_OPENWA_DURABLE_INTAKE','test_only')})
describe('durable intake evidence',()=>{
 it('accepts only exact pinned TEST gate',()=>{
  expect(durableOpenWAIntakeEnabled()).toBe(true)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://pqirsnfupofhulmewakq.supabase.co.evil.example')
  expect(durableOpenWAIntakeEnabled()).toBe(false)
 })
 it('deduplicates delivery timestamps and property ordering, not changed payload',()=>{
  expect(intakeDigest(envelope)).toBe(intakeDigest({...envelope,timestamp:'2026-11-26T14:01:00Z',data:{media:{data:'aGVsbG8='},text:'private fixture'}}))
  expect(intakeDigest(envelope)).not.toBe(intakeDigest({...envelope,data:{text:'changed'}}))
 })
 it('binds authenticated encrypted envelope to account, connection, event and native data',()=>{
  const sealed=sealIntake(binding,envelope)
  const claim:IntakeClaim={state:'claimed',id,account_id:account,connection_id:connection,event_id:'evt',session_id:'fixture',instance_id:null,canonical:true,token,ciphertext:sealed.ciphertext,digest:sealed.digest}
  expect(readIntakeClaim(claim)).toEqual(claim)
  expect(openIntake(claim)).toMatchObject(envelope)
  expect(()=>openIntake({...claim,account_id:connection})).toThrow('Intake evidence unavailable')
  expect(()=>openIntake({...claim,digest:'a'.repeat(64)})).toThrow('Intake evidence unavailable')
  expect(()=>openIntake({...claim,ciphertext:'iv:ct'})).toThrow('Intake evidence unavailable')
  expect(sealed.ciphertext).not.toContain('private fixture')
 })
 it('returns queued only from the successful durable SQL contract',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:'accepted',error:null}),db={rpc} as never
  expect(await enqueueVerifiedIntake(db,binding,envelope,envelope.timestamp,false)).toEqual({duplicate:false,queued:true,queueDuplicate:false})
  expect(rpc).toHaveBeenCalledWith('openwa_enqueue_signed_intake',expect.objectContaining({p_account:account,p_connection:connection,p_canonical:false,p_credential_version:envelope.timestamp}))
  rpc.mockResolvedValueOnce({data:'capacity',error:null});await expect(enqueueVerifiedIntake(db,binding,envelope,envelope.timestamp,false)).rejects.toThrow('receipt could not be reserved')
  rpc.mockResolvedValueOnce({data:'conflict',error:null});await expect(enqueueVerifiedIntake(db,binding,envelope,envelope.timestamp,false)).rejects.toThrow('identity conflict')
 })
 it('enforces stream limits even without Content-Length and preserves UTF-8',async()=>{
  expect(await readDurableWebhookBody(new Request('https://fixture.example',{method:'POST',body:'مرحبا'}))).toBe('مرحبا')
  const tooLarge=new Uint8Array(MAX_DURABLE_BODY_BYTES+1)
  await expect(readDurableWebhookBody(new Request('https://fixture.example',{method:'POST',body:tooLarge}))).rejects.toThrow()
  await expect(readDurableWebhookBody(new Request('https://fixture.example',{method:'POST',headers:{'content-length':String(MAX_DURABLE_BODY_BYTES+1)},body:'small'}))).rejects.toThrow()
 })
})
