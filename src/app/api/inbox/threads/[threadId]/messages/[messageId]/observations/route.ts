import { inboxRead } from '@/lib/inbox/read-api'
export const dynamic = 'force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{threadId:string;messageId:string}>}) {
 const {threadId,messageId}=await params
 return inboxRead(request,'observations',{thread:threadId,message:messageId})
}
