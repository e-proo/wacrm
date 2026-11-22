import { inboxRead } from '@/lib/inbox/read-api'
export const dynamic = 'force-dynamic'
export const GET = (request: Request) => inboxRead(request,'threads')

import { openScopedThread } from '@/lib/inbox/scoped-action-route'
export const POST = (request: Request) => openScopedThread(request)
