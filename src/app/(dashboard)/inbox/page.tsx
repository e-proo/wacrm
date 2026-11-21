import { Suspense } from 'react'
import LegacyInbox from './legacy-inbox'
import { ScopedInbox } from '@/components/inbox/scoped-inbox'
import { scopedInboxEnabled } from '@/lib/inbox/scoped-ui-gate'
export const dynamic = 'force-dynamic'
export default function InboxPage() {
 return scopedInboxEnabled() ? <Suspense fallback={null}><ScopedInbox /></Suspense> : <LegacyInbox />
}
