'use client'
import {useEffect,useState} from 'react'
import {useTranslations} from 'next-intl'
import {createClient} from '@/lib/supabase/client'
import type {Contact} from '@/types'
import type {InboxContext,ScopedRow} from '@/lib/inbox/scoped-list-model'
import {ContactSidebar} from './contact-sidebar'

// Reuse the existing CRM panel. Contact details are read through the
// authenticated browser client + RLS, never through an exposed service-role
// projection. Scope every request to the selected account/contact pair.
export function ScopedContactPanel({row,ctx}:{row:ScopedRow;ctx:InboxContext}){
 const t=useTranslations('Inbox.scoped')
 const [state,setState]=useState<{key:string;value:Contact|null;error:boolean}|null>(null)
 const key=ctx.accountId+':'+row.contact.id
 useEffect(()=>{
  let cancelled=false
  const db=createClient()
  void (async()=>{
   try{
    const {data,error}=await db.from('contacts').select('*').eq('account_id',ctx.accountId).eq('id',row.contact.id).maybeSingle()
    if(!cancelled)setState({key,value:error?null:data as Contact|null,error:Boolean(error||!data)})
   }catch{if(!cancelled)setState({key,value:null,error:true})}
  })()
  return()=>{cancelled=true}
 },[ctx.accountId,row.contact.id,key])
 if(!state||state.key!==key)return <p role="status" className="p-4 text-xs text-muted-foreground">{t('actionContactLoading')}</p>
 if(state.error||!state.value)return <p role="alert" className="p-4 text-xs text-destructive">{t('actionContactUnavailable')}</p>
 return <ContactSidebar contact={state.value}/>
}
