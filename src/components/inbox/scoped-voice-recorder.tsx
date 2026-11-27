'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {useTranslations} from 'next-intl'
import {Mic,Square,X} from 'lucide-react'
import {Button} from '@/components/ui/button'

type Job={recorder:import('opus-recorder').default|null;timer:ReturnType<typeof setTimeout>|null;stopping:boolean}
const MAX_SECONDS=300
export function ScopedVoiceRecorder({disabled,onBusyChange,onFile,compact=false}:{disabled:boolean;compact?:boolean;onBusyChange:(busy:boolean)=>void;onFile:(file:File)=>Promise<void>}){
 const t=useTranslations('Inbox.composer'),s=useTranslations('Inbox.scoped')
 const job=useRef<Job|null>(null),fileCallback=useRef(onFile)
 const [state,setState]=useState<'idle'|'starting'|'recording'|'finishing'>('idle')
 const [error,setError]=useState(false),[seconds,setSeconds]=useState(0)
 useEffect(()=>{fileCallback.current=onFile},[onFile])
 const cancel=useCallback(()=>{
  const current=job.current
  job.current=null
  if(current?.timer)clearTimeout(current.timer)
  if(current?.recorder&&!current.stopping)void current.recorder.stop().catch(()=>{})
  setState('idle');onBusyChange(false)
 },[onBusyChange])
 useEffect(()=>()=>{const current=job.current;job.current=null;if(current?.timer)clearTimeout(current.timer);if(current?.recorder&&!current.stopping)void current.recorder.stop().catch(()=>{})},[])
 useEffect(()=>{if(disabled&&job.current)cancel()},[disabled,cancel])
 useEffect(()=>{
  if(state!=='recording')return
  const started=performance.now(),timer=setInterval(()=>setSeconds(Math.min(MAX_SECONDS,Math.floor((performance.now()-started)/1000))),250)
  return()=>clearInterval(timer)
 },[state])
 const stop=useCallback(()=>{
  const current=job.current
  if(!current?.recorder||current.stopping)return
  current.stopping=true
  if(current.timer)clearTimeout(current.timer)
  setState('finishing')
  void current.recorder.stop().catch(()=>{if(job.current===current){cancel();setError(true)}})
  // Never unlock a pending upload. If the encoder never returns bytes,
  // cancel only the inactive recorder after a bounded wait.
  current.timer=setTimeout(()=>{if(job.current===current){cancel();setError(true)}},15000)
 },[cancel])
 async function start(){
  if(disabled||job.current)return
  if(!navigator.mediaDevices?.getUserMedia||typeof AudioContext==='undefined'){setError(true);return}
  const current:Job={recorder:null,timer:null,stopping:false}
  job.current=current;onBusyChange(true);setError(false);setSeconds(0);setState('starting')
  try{
   const {default:Recorder}=await import('opus-recorder')
   if(job.current!==current)return
   const recorder=new Recorder({encoderPath:'/opus/encoderWorker.min.js',numberOfChannels:1,encoderApplication:2048,encoderSampleRate:48000,streamPages:false})
   current.recorder=recorder
   recorder.ondataavailable=bytes=>{
    if(job.current!==current||!current.stopping)return
    if(current.timer)clearTimeout(current.timer)
    current.timer=null
    if(!bytes.length){cancel();setError(true);return}
    const file=new File([bytes as unknown as BlobPart],'voice-'+Date.now()+'.ogg',{type:'audio/ogg'})
    // No dispatch here. The scoped composer stages the file and keeps
    // the explicit send action and idempotency journal unchanged.
    void fileCallback.current(file).catch(()=>setError(true)).finally(()=>{
     if(job.current===current){job.current=null;setState('idle');onBusyChange(false)}
    })
   }
   await recorder.start()
   if(job.current!==current){void recorder.stop().catch(()=>{});return}
   setState('recording')
   current.timer=setTimeout(stop,MAX_SECONDS*1000)
  }catch{if(job.current===current){cancel();setError(true)}}
 }
 return <div className={state==='idle'?'flex items-center gap-1':'flex w-full items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5'}>
  {state==='idle'?<Button type="button" size="sm" variant={compact?'ghost':'outline'} className={compact?'h-9 w-9 shrink-0 p-0 text-muted-foreground':undefined} aria-label={t('voiceNote')} title={t('voiceNote')} disabled={disabled} onClick={()=>void start()}><Mic className="size-4"/>{!compact&&t('voiceNote')}</Button>:<>
   <span role="status" className="text-xs tabular-nums text-muted-foreground">{state==='recording'?t('recording',{current:Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'),max:'5:00'}):s('loading')}</span>
   {state==='recording'&&<Button type="button" size="sm" variant="outline" onClick={stop}><Square className="size-3"/>{t('stopAndAttach')}</Button>}
   {state!=='finishing'&&<Button type="button" size="sm" variant="ghost" onClick={cancel} aria-label={t('cancel')}><X className="size-4"/></Button>}
  </>}
  {error&&<span role="alert" className="text-xs text-destructive">{s('actionRecordingFailed')}</span>}
 </div>
}
