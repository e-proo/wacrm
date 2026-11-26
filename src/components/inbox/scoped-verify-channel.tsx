'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCan } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import type { InboxContext } from '@/lib/inbox/scoped-list-model'

const reasonKeys = {
  namespace_engine_unverified: 'nativeEngineUnverified',
  namespace_version_unsupported: 'nativeVersionUnsupported',
  namespace_engine_unsupported: 'nativeEngineUnsupported',
  namespace_session_not_live: 'nativeSessionNotLive',
  namespace_webhook_unconfigured: 'nativeWebhookUnconfigured',
  namespace_handover_requires_proof: 'nativeHandoverBlocked',
  namespace_enrollment_failed: 'nativeEnrollmentFailed',
} as const

// Identity-only verification never changes a primary. The separate explicit
// action verifies the pinned native contract before assigning the primary.
export function ScopedVerifyChannel({ connectionId, ctx, identityUnverified, openwa, onVerified }: {
  connectionId: string; ctx: InboxContext; identityUnverified: boolean; openwa: boolean; onVerified: () => void
}) {
  const t = useTranslations('Inbox.scoped')
  const authorized = useCan('edit-settings')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; key: string } | null>(null)
  if (!authorized) return null
  async function verify(makePrimary: boolean) {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const response = await fetch('/api/inbox/connections/' + encodeURIComponent(connectionId) + '/verify-channel', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-wacrm-inbox-account': ctx.accountId, 'x-wacrm-inbox-actor': ctx.userId },
        body: JSON.stringify({ makePrimary }),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok || !result || typeof result !== 'object' || !('channelId' in result) || typeof result.channelId !== 'string' ||
          (makePrimary && (!('namespaceVerified' in result) || result.namespaceVerified !== true))) {
        const code = result && typeof result === 'object' && 'code' in result ? result.code : null
        const reason = typeof code === 'string' && Object.prototype.hasOwnProperty.call(reasonKeys, code)
          ? reasonKeys[code as keyof typeof reasonKeys] : 'verifyChannelFailed'
        setOutcome({ ok: false, key: reason })
        return
      }
      setOutcome({ ok: true, key: makePrimary ? 'nativeEnrollmentSuccess' : 'verifyChannelSuccess' })
      onVerified()
    } catch { setOutcome({ ok: false, key: 'verifyChannelFailed' }) }
    finally { setBusy(false) }
  }
  return <div className="mt-2 space-y-1">
    {identityUnverified && <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void verify(false)}>
      {t(busy ? 'verifyingChannel' : 'verifyChannel')}
    </Button>}
    {openwa && <><Button type="button" variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void verify(true)}>
      {t(busy ? 'verifyingChannel' : 'nativeEnrollPrimary')}
    </Button><p className="text-[11px] text-muted-foreground">{t('nativeEnrollExplanation')}</p></>}
    {outcome && <p role={outcome.ok ? 'status' : 'alert'} className="text-[11px] text-muted-foreground">{t(outcome.key)}</p>}
  </div>
}
