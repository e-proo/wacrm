import { acknowledgeScopedThread } from '@/lib/inbox/scoped-read-action'
export const dynamic='force-dynamic'
export async function POST(request:Request,{params}:{params:Promise<{threadId:string}>}){
 const {threadId}=await params
 return acknowledgeScopedThread(request,threadId)
}
