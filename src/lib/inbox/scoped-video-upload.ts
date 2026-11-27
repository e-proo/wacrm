// Exact-size, allowlisted video staging. No provider dispatch or retry.
export const VIDEO_LIMIT=16*1024*1024
export function scopedVideoMime(name:string,type:string):'video/mp4'|'video/3gpp'|null{
 const ext=name.split('.').pop()?.toLowerCase(),mime=type.toLowerCase().split(';')[0]
 if(ext==='mp4'&&['','application/octet-stream','video/mp4'].includes(mime))return 'video/mp4'
 if((ext==='3gp'||ext==='3gpp')&&['','application/octet-stream','video/3gpp','video/3gp'].includes(mime))return 'video/3gpp'
 return null
}
export function validVideoSize(size:number){return Number.isSafeInteger(size)&&size>8&&size<=VIDEO_LIMIT}
export function hasVideoContainer(bytes:Uint8Array){return bytes.length>=12&&bytes[4]===102&&bytes[5]===116&&bytes[6]===121&&bytes[7]===112}
export async function uploadScopedVideo(file:File,ctx:{accountId:string;userId:string},scope:{threadId:string;channelId:string;connectionId:string}){
 const mime=scopedVideoMime(file.name,file.type)
 if(!mime)throw Error('VIDEO_FORMAT')
 if(!validVideoSize(file.size))throw Error('VIDEO_SIZE')
 let res:Response
 try{res=await fetch('/api/inbox/threads/'+scope.threadId+'/video-upload?'+new URLSearchParams({channel_id:scope.channelId,connection_id:scope.connectionId}),{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':mime,'x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId,'x-wacrm-upload-size':String(file.size)},body:file})}
 catch{throw Error('VIDEO_NETWORK')}
 const body=await res.json().catch(()=>null)
 if(!res.ok)throw Error('VIDEO_HTTP_'+res.status)
 if(!body||typeof body.path!=='string'||!body.path.startsWith('account-'+ctx.accountId+'/')||typeof body.publicUrl!=='string')throw Error('VIDEO_RESPONSE')
 return {path:body.path as string,publicUrl:body.publicUrl as string}
}
