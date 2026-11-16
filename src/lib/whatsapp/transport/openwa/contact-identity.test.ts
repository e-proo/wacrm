import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveOpenWAInboundContactIdentity } from './contact-identity'

const ACCOUNT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONNECTION='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OLD_CONNECTION='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LID='123456789012345@lid'
const PHONE='967773000299'
const OLD_CONTACT='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const FALSE_CONTACT='ffffffff-ffff-4fff-8fff-ffffffffffff'

function fixture(opts: {
  currentIdentity?: string | null
  related?: Array<{id:string}>
  inbound?: Array<{conversation_id:string}>
  threads?: Array<{id:string;contact_id:string}>
  contacts?: Array<{id:string;phone:string;phone_normalized:string}>
  errorTable?: string
}={}) {
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = []
  const rows: Record<string, unknown> = {
    related: opts.related ?? [{id: CONNECTION},{id:OLD_CONNECTION}],
    inbound: opts.inbound ?? [{conversation_id:'conv-new'}, {conversation_id:'conv-old'}],
    threads: opts.threads ?? [{id:'conv-new',contact_id:FALSE_CONTACT},{id:'conv-old',contact_id:OLD_CONTACT}],
    contacts: opts.contacts ?? [
      {id: FALSE_CONTACT,phone:'123456789012345',phone_normalized:'123456789012345'},
      {id: OLD_CONTACT,phone:PHONE,phone_normalized:PHONE},
    ],
  }
  const db = {
    from:vi.fn((table:string) => {
      const filters:Record<string,unknown>={}
      const builder={
        select: () => builder,
        eq:(k:string,v:unknown)=>{filters[k]=v;return builder},
        is:(k:string,v:unknown)=>{filters[k]=v;return builder},
        in:(k:string,v:unknown)=>{filters[k]=v;return builder},
        order:()=>builder,
        limit:()=>builder,
        maybeSingle:async()=>{
          calls.push({table,filters:{...filters}})
          return table==='whatsapp_connections'
            ? {data: {phone_identity:opts.currentIdentity === undefined?'owner-phone':opts.currentIdentity},error:null}
            : {data:null,error:null}
        },
        then:(resolve:(value:unknown)=>unknown)=>{
          calls.push({table,filters:{...filters}})
          const data=table==='whatsapp_connections'?rows.related
            :table==='messages'?rows.inbound:table==='conversations'?rows.threads:rows.contacts
          return Promise.resolve(resolve({
            data:opts.errorTable===table?null:data,
            error:opts.errorTable===table?{code:'db_unavailable'}:null,
          }))
        },
      }
      return builder
    }),
  } as unknown as SupabaseClient
  return {db,calls}
}

describe('OpenWA signed inbound contact resolution',()=>{
  it('accepts a real phone from the signed native @c.us sender and never queries aliases',async()=>{
    const {db,calls}=fixture()
    expect(await resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:PHONE,providerChatId:PHONE+'@c.us'}))
      .toEqual({phone:PHONE,contactId:null,source:'sender_phone'})
    expect(calls).toEqual([])
  })
  it('uses a distinct explicit senderPhone supplied with a signed @lid',async()=>{
    const {db,calls}=fixture()
    expect(await resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:PHONE,providerChatId:LID}))
      .toEqual({phone:PHONE,contactId:null,source:'sender_phone'})
    expect(calls).toEqual([])
  })
  it('recovers the unique real phone from the same-account same-own-number historical native LID',async()=>{
    const {db,calls}=fixture()
    expect(await resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
      .toEqual({phone:PHONE,contactId:OLD_CONTACT,source:'historical_native_lid'})
    expect(calls).toEqual([
      {table:'whatsapp_connections',filters:{id:CONNECTION,account_id:ACCOUNT,provider:'openwa',archived_at:null}},
      {table:'whatsapp_connections',filters:{account_id:ACCOUNT,provider:'openwa',phone_identity:'owner-phone'}},
      {table:'messages',filters:{provider:'openwa',sender_type:'customer',provider_chat_id:LID,connection_id:[CONNECTION,OLD_CONNECTION]}},
      {table:'conversations',filters:{account_id:ACCOUNT,id:['conv-new','conv-old']}},
      {table:'contacts',filters:{account_id:ACCOUNT,id:[FALSE_CONTACT,OLD_CONTACT]}},
    ])
  })
  it('fails closed when only the fake LID-digit contact exists, or history is ambiguous',async()=>{
    const onlyFake=fixture({contacts:[{id:FALSE_CONTACT,phone:LID.split('@')[0],phone_normalized:LID.split('@')[0]}],
      inbound:[{conversation_id:'conv-new'}],threads:[{id:'conv-new',contact_id:FALSE_CONTACT}]})
    await expect(resolveOpenWAInboundContactIdentity(onlyFake.db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
      .rejects.toMatchObject({code:'connection_restricted'})
    const different=fixture({contacts:[
      {id:FALSE_CONTACT,phone:'967700000001',phone_normalized:'967700000001'},
      {id:OLD_CONTACT,phone:PHONE,phone_normalized:PHONE},
    ]})
    await expect(resolveOpenWAInboundContactIdentity(different.db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
      .rejects.toMatchObject({code:'connection_restricted'})
  })
  it('does not borrow history from a different linked number or unrelated tenant',async()=>{
    for(const value of [null,'']) {
      const {db}=fixture({currentIdentity:value})
      await expect(resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
        .rejects.toMatchObject({code:'connection_restricted'})
    }
    const {db}=fixture({threads:[{id:'conv-new',contact_id:FALSE_CONTACT}]})
    await expect(resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
      .rejects.toMatchObject({code:'connection_restricted'})
  })
  it('rejects inconsistent chat or database lookup failure rather than making a contact',async()=>{
    const {db}=fixture()
    for(const invalid of [undefined,'bad@group','123456789012346@c.us']) {
      await expect(resolveOpenWAInboundContactIdentity(db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:PHONE,providerChatId:invalid}))
        .rejects.toMatchObject({code:'connection_restricted'})
    }
    const error=fixture({errorTable:'messages'})
    await expect(resolveOpenWAInboundContactIdentity(error.db,{accountId:ACCOUNT,connectionId:CONNECTION,sender:LID,providerChatId:LID}))
      .rejects.toMatchObject({code:'retryable_provider_failure'})
  })
})
