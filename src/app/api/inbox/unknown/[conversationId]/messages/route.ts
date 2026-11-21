import { inboxRead } from '@/lib/inbox/read-api'
export const dynamic = 'force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{conversationId:string}>}) {
 const {conversationId}=await params
 return inboxRead(request,'history',{parent:conversationId})
}
