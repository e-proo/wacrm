import {describe,expect,it} from 'vitest'
import {actionFingerprint,decodeIntent,parseActionScope,type ActionScope} from './action-intent-model'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const scope:ActionScope={threadId:id(1),channelId:id(2),connectionId:id(3),membershipId:id(4),provider:'openwa'}
describe('scoped action identity',()=>{
 it('requires an explicit channel, connection and membership epoch',()=>{
  expect(parseActionScope(scope)).toEqual(scope)
  expect(parseActionScope({...scope,membershipId:null})).toBeNull()
  expect(parseActionScope({...scope,provider:'unknown'})).toBeNull()
  expect(parseActionScope({...scope,accountId:id(9)})).toBeNull()
 })
 it('pins payload, action, recipient, connection and epoch to one fingerprint',()=>{
  const f=actionFingerprint(scope,'send','1234567@c.us',{text:'one',type:'text'})
  expect(actionFingerprint(scope,'send','1234567@c.us',{type:'text',text:'one'})).toBe(f)
  for(const s of [{...scope,connectionId:id(5)},{...scope,membershipId:id(5)},{...scope,channelId:id(5)}])expect(actionFingerprint(s,'send','1234567@c.us',{text:'one',type:'text'})).not.toBe(f)
  expect(actionFingerprint(scope,'send','7654321@c.us',{text:'one',type:'text'})).not.toBe(f)
  expect(actionFingerprint(scope,'send','1234567@c.us',{text:'two',type:'text'})).not.toBe(f)
  expect(actionFingerprint(scope,'reaction','1234567@c.us',{text:'one',type:'text'})).not.toBe(f)
 })
 it('never treats an uncertain or repeated request as a new claim',()=>{
  for(const state of ['pending','accepted','blocked','uncertain'])expect(decodeIntent({state,intent_id:id(1)}).state).toBe(state)
  expect(decodeIntent({state:'conflict'}).state).toBe('conflict')
  expect(()=>decodeIntent({state:'claimed'})).toThrow()
  expect(()=>decodeIntent({state:'retry'})).toThrow()
 })
})
