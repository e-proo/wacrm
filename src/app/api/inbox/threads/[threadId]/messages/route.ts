import { inboxRead } from '@/lib/inbox/read-api'
export const dynamic = 'force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{threadId:string}>}) {
 const {threadId}=await params
 return inboxRead(request,'history',{thread:threadId})
}
