'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCan } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'

// Only an owner/admin can request verified, tenant-scoped enrollment.
// The server separately enforces TEST + shadow gate and obtains the exact
// phone identity from a live authenticated provider. No CRM send or backfill.
export function ScopedVerifyChannel({ connectionId, onVerified }: { connectionId: string; onVerified: () => void }) {
  const t = useTranslations('Inbox.scoped')
  const authorized = useCan('edit-settings')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'success' | 'failure' | null>(null)
  if (!authorized) return null
  async function verify() {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const response = await fetch('/api/inbox/connections/' + encodeURIComponent(connectionId) + '/verify-channel', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ makePrimary: false }),
      })
      if (!response.ok) throw new Error('not verified')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('channelId' in result) || typeof result.channelId !== 'string') {
        throw new Error('not verified')
      }
      setOutcome('success')
      onVerified()
    } catch {
      setOutcome('failure')
    } finally {
      setBusy(false)
    }
  }
  return <div className="mt-2 space-y-1">
    <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void verify()}>
      {t(busy ? 'verifyingChannel' : 'verifyChannel')}
    </Button>
    {outcome && <p role={outcome === 'failure' ? 'alert' : 'status'} className="text-[11px] text-muted-foreground">
      {t(outcome === 'success' ? 'verifyChannelSuccess' : 'verifyChannelFailed')}
    </p>}
  </div>
}
