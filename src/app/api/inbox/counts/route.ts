import { inboxRead } from '@/lib/inbox/read-api'
export const dynamic = 'force-dynamic'
export const GET = (request: Request) => inboxRead(request,'counts')
