import {performScopedAction,getScopedAction} from '@/lib/inbox/scoped-action-route'
export const dynamic='force-dynamic'
export const maxDuration=90
export async function POST(request:Request,{params}:{params:Promise<{threadId:string}>}){
 const {threadId}=await params
 return performScopedAction(request,threadId)
}

export async function GET(request:Request,{params}:{params:Promise<{threadId:string}>}){return getScopedAction(request,(await params).threadId)}
