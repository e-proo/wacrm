'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Play, RefreshCw, ShieldCheck, Square, SlidersHorizontal } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseOpenWAApiResponse } from '@/lib/whatsapp/transport/openwa/browser-api-response'
import { normalizeTestRecipient } from '@/lib/whatsapp/transport/openwa/pilot-recipient-input'
import { useWhatsAppLabels } from './whatsapp-labels'

interface PilotState extends Record<string, unknown> {
  connectionId: string
  status: string
  enforced: boolean
  pilot_enabled: boolean
  configured: boolean
  active: boolean
  paused: boolean
  active_admissions: number
  unsettled_outbound: number
  same_identity_ready_connections: number
  error?: string
  guardrails: {
    hourly_cap: number
    daily_cap: number
    first_touch_daily_cap: number
    minimum_interval_ms: number
    jitter_ms: number
  }
}

type RelatedConnection = { id: string; status: string; sessionId: string | null }
type PilotAction = 'prepare' | 'limits' | 'grant' | 'activate' | 'stop' | 'disable' | 'enable'
type PilotStep = 'protected' | 'pending' | 'needsStop' | 'verify' | 'prepare' | 'approve' | 'start' | 'active' | 'multiple' | 'normal'

const defaultLimits = { hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
  minimum_interval_ms: 15000, jitter_ms: 3000 }

export function OpenWAPilotControls({
  connectionId,
  relatedConnections = [],
  onPilotChange,
}: {
  connectionId: string
  relatedConnections?: RelatedConnection[]
  onPilotChange?: () => void
}) {
  const w = useWhatsAppLabels()
  const [state, setState] = useState<PilotState | null>(null)
  const [limits, setLimits] = useState(defaultLimits)
  const [recipient, setRecipient] = useState('')
  const [consent, setConsent] = useState(false)
  const [duplicateAck, setDuplicateAck] = useState(false)
  const [verified, setVerified] = useState(false)
  const [verifiedStatus, setVerifiedStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/pilot`
  const normalizedRecipient = useMemo(() => normalizeTestRecipient(recipient), [recipient])

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      const data = await parseOpenWAApiResponse<PilotState>(res)
      if (!res.ok) throw new Error(data.error || 'Pilot status unavailable')
      setState(data)
      setLimits({
        hourly_cap: data.guardrails.hourly_cap,
        daily_cap: data.guardrails.daily_cap,
        first_touch_daily_cap: data.guardrails.first_touch_daily_cap,
        minimum_interval_ms: data.guardrails.minimum_interval_ms,
        jitter_ms: data.guardrails.jitter_ms,
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pilot status unavailable')
      setState(null)
      setVerified(false)
    } finally { setLoading(false) }
  }, [endpoint])

  useEffect(() => { void load() }, [load])

  // This is an actual read against the provider, not a copy of stale WACRM DB status.
  async function verifyGateway() {
    if (busy || verifying) return
    setVerifying(true)
    setError(null)
    setNotice(null)
    setVerified(false)
    setVerifiedStatus(null)
    try {
      const res = await fetch(`/api/whatsapp/connections/openwa/${connectionId}`, { cache: 'no-store' })
      const data = await parseOpenWAApiResponse<{ error?: string; status?: string }>(res)
      if (!res.ok) throw new Error(data.error || w('devPilotVerifyFailed'))
      setVerifiedStatus(data.status ?? null)
      if (!['ready', 'connected'].includes(data.status ?? '')) throw new Error(w('devPilotVerifyNotReady'))
      setVerified(true)
      setNotice(w('devPilotVerifySuccess'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : w('devPilotVerifyFailed'))
    } finally { setVerifying(false) }
  }

  async function submit(action: PilotAction) {
    if (busy || verifying) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = { action }
      if (action === 'prepare') body.confirm_prepare = true
      if (action === 'limits') Object.assign(body, limits)
      if (action === 'grant') Object.assign(body, {
        recipient: normalizedRecipient, consent_confirmed: consent,
        ack_duplicate_sessions: duplicateAck, hours: 4,
      })
      if (action === 'activate' || action === 'disable') body.ack_duplicate_sessions = duplicateAck
      if (action === 'disable') body.confirm_normal_sending = true
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store',
      })
      const data = await parseOpenWAApiResponse<PilotState>(res)
      if (!res.ok) throw new Error(data.error || w('devPilotActionRejected'))
      setState(data)
      if (action === 'grant') { setRecipient(''); setConsent(false) }
      if (['stop', 'disable', 'enable'].includes(action)) { setVerified(false); setDuplicateAck(false); setVerifiedStatus(null) }
      if (action === 'stop' || action === 'disable' || action === 'enable') onPilotChange?.()
      setNotice(w(action === 'prepare' ? 'devPilotPrepared'
        : action === 'disable' ? 'devPilotDisabled' : action === 'enable' ? 'devPilotEnabled'
        : action === 'stop' ? 'devPilotStopped'
        : action === 'activate' ? 'devPilotStarted'
        : action === 'grant' && data.recipient_identity_source === 'verified_inbound_chat'
          ? 'devPilotGrantedNativeChat'
          : action === 'grant' ? 'devPilotGranted' : 'devPilotLimitsSaved'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : w('devPilotActionRejected'))
    } finally { setBusy(false) }
  }

  const step: PilotStep | null = !state ? null
    : !state.pilot_enabled ? 'normal'
    : !state.enforced ? 'protected'
    : state.unsettled_outbound > 0 ? 'pending'
    : !state.paused && !state.active ? 'needsStop'
    : state.active ? 'active'
    : !verified ? 'verify'
    : !state.configured ? 'prepare'
    : state.active_admissions === 0 ? 'approve'
    : state.active_admissions === 1 ? 'start'
    : 'multiple'
  const running = busy || verifying
  const needsDuplicateReview = (state?.same_identity_ready_connections ?? 0) > 1
  const canApprove = Boolean(state?.configured && state.enforced && state.paused && normalizedRecipient
    && consent && verified && state.unsettled_outbound === 0 && (!needsDuplicateReview || duplicateAck))
  const canStart = Boolean(state?.configured && state.enforced && state.paused && verified
    && state.active_admissions === 1 && state.unsettled_outbound === 0
    && (!needsDuplicateReview || duplicateAck))

  return <Card className="border-border/70">
    <CardHeader className="space-y-2 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">{w('devPilotEasyTitle')}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {state?.enforced && state.pilot_enabled && <Badge variant="outline"><ShieldCheck className="size-3" />{w('devPilotProtected')}</Badge>}
          {state && <Badge variant={state.active ? 'default' : 'secondary'}>
            {!state.pilot_enabled ? w('devPilotNormalMode') : state.active ? w('devPilotActive') : w('devPilotPaused')}
          </Badge>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{w('devPilotEasyHint')}</p>
    </CardHeader>

    <CardContent className="space-y-4">
      {loading && <p className="text-sm text-muted-foreground">{w('devPilotLoading')}</p>}
      {error && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><CheckCircle2 className="size-4" /><AlertDescription>{notice}</AlertDescription></Alert>}

      {state && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{w('devPilotModeTitle')}</p>
          <p className="text-xs text-muted-foreground">{w(state.pilot_enabled ? 'devPilotModeEnabledHint' : 'devPilotModeDisabledHint')}</p>
        </div>
        {state.pilot_enabled
          ? <Button variant="outline" disabled={running || (needsDuplicateReview && !duplicateAck)}
              onClick={() => { if (window.confirm(w('devPilotDisableConfirm'))) void submit('disable') }}>
              {w('devPilotDisableButton')}
            </Button>
          : <div className="flex flex-wrap gap-2">
              {state.paused && <Button disabled={running || (needsDuplicateReview && !duplicateAck)}
                onClick={() => { if (window.confirm(w('devPilotDisableConfirm'))) void submit('disable') }}>
                {w('devPilotResumeNormal')}
              </Button>}
              <Button variant="outline" disabled={running} onClick={() => void submit('enable')}>
                {w('devPilotEnableButton')}
              </Button>
            </div>}
      </div>}

      {state && <>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([
            [w('devPilotVerifiedGateway'), verified ? w('devPilotYes') : w('devPilotNo')],
            [w('devPilotGrants'), String(state.active_admissions)],
            [w('devPilotPending'), String(state.unsettled_outbound)],
            [w('devPilotHourly'), String(state.guardrails.hourly_cap)],
          ] as const).map(([label, value]) =>
            <div key={label} className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 font-semibold tabular-nums">{value}</p>
            </div>,
          )}
        </div>

        {state.pilot_enabled && <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
          {([
            [w('devPilotStepVerify'), verified || step === 'active'],
            [w('devPilotStepPrepare'), state.configured],
            [w('devPilotStepApprove'), state.active_admissions === 1 || step === 'active'],
            [w('devPilotStepStart'), step === 'active'],
          ] as const).map(([label, complete], index) =>
            <div key={label} className={`rounded-md px-1 py-2 ${complete ? 'bg-primary/10 text-foreground' : 'bg-muted/50 text-muted-foreground'}`}>
              {complete ? <CheckCircle2 className="mx-auto mb-1 size-4" /> : <span className="mx-auto mb-1 block font-semibold">{index + 1}</span>}
              {label}
            </div>,
          )}
        </div>}

        {needsDuplicateReview && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">{w('devPilotDuplicateCount')} ({state.same_identity_ready_connections})</p>
          <p className="mt-1 text-xs text-muted-foreground">{w('devPilotDuplicateExplain')}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm font-medium underline underline-offset-4">{w('devPilotInspectSessions')}</summary>
            <ul className="mt-2 space-y-2 text-xs">
              {relatedConnections.map((connection) => <li key={connection.id} className="rounded-md border bg-background p-2">
                <div className="font-medium">{connection.id === connectionId ? w('devPilotChosenSession') : w('devPilotOtherSession')} · {connection.status}</div>
                <div className="break-all text-muted-foreground">WACRM: {connection.id}</div>
                <div className="break-all text-muted-foreground">OpenWA: {connection.sessionId || '—'}</div>
              </li>)}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">{w('devPilotDuplicateCompare')}</p>
          </details>
          <div className="mt-3 flex items-start gap-2">
            <Checkbox id={`pilot-duplicate-${connectionId}`} checked={duplicateAck}
              disabled={running} onCheckedChange={(v) => setDuplicateAck(v === true)} />
            <Label htmlFor={`pilot-duplicate-${connectionId}`} className="text-sm leading-relaxed">{w('devPilotDuplicateAck')}</Label>
          </div>
        </div>}

        {step === 'normal' && <Alert><AlertDescription>{w('devPilotNormalModeHint')}</AlertDescription></Alert>}
        {step === 'protected' && <Alert variant="destructive"><AlertDescription>{w('devPilotEnforceRequired')}</AlertDescription></Alert>}
        {step === 'pending' && <Alert variant="destructive"><AlertDescription>{w('devPilotUnsettledBlocked')}</AlertDescription></Alert>}
        {step === 'needsStop' && <Alert variant="destructive">
          <AlertDescription>{w('devPilotNoGrantUnpaused')}</AlertDescription>
        </Alert>}
        {step === 'multiple' && <Alert variant="destructive"><AlertDescription>{w('devPilotTooManyGrants')}</AlertDescription></Alert>}

        {step === 'verify' && <section className="space-y-2 rounded-lg border p-4">
          <p className="font-semibold">{w('devPilotVerifyTitle')}</p>
          <p className="text-sm text-muted-foreground">{w('devPilotVerifyDescription')}</p>
          {verifiedStatus && <p className="text-sm">{w('status')} {verifiedStatus}</p>}
          <Button disabled={running} onClick={() => void verifyGateway()}>
            <RefreshCw className={`me-2 size-4 ${verifying ? 'animate-spin' : ''}`} />
            {w('devPilotVerifyButton')}
          </Button>
        </section>}

        {step === 'prepare' && <section className="space-y-2 rounded-lg border p-4">
          <p className="font-semibold">{w('devPilotNeedsSetup')}</p>
          <p className="text-sm text-muted-foreground">{w('devPilotSetupHint')}</p>
          <Button disabled={running} onClick={() => void submit('prepare')}>{w('devPilotPrepare')}</Button>
        </section>}

        {step === 'approve' && <section className="space-y-3 rounded-lg border p-4">
          <div>
            <p className="font-semibold">{w('devPilotApproveTitle')}</p>
            <p className="text-sm text-muted-foreground">{w('devPilotApproveDescription')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`pilot-recipient-${connectionId}`}>{w('devPilotRecipient')}</Label>
            <Input id={`pilot-recipient-${connectionId}`} value={recipient} autoComplete="off"
              dir="ltr" placeholder="+9677XXXXXXXX" disabled={running}
              onChange={(e) => setRecipient(e.target.value)} />
            <p className="text-xs text-muted-foreground">{w('devPilotRecipientFormat')}</p>
            {recipient.trim() && !normalizedRecipient && <p className="text-xs text-destructive">{w('devPilotInvalidRecipient')}</p>}
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id={`pilot-consent-${connectionId}`} checked={consent} disabled={running}
              onCheckedChange={(v) => setConsent(v === true)} />
            <Label htmlFor={`pilot-consent-${connectionId}`} className="text-sm leading-relaxed">{w('devPilotConsent')}</Label>
          </div>
          {needsDuplicateReview && !duplicateAck &&
            <p className="text-xs text-amber-600 dark:text-amber-400">{w('devPilotMustReviewDuplicates')}</p>}
          <Button disabled={running || !canApprove} onClick={() => void submit('grant')}>
            {w('devPilotGrant')}
          </Button>
        </section>}

        {step === 'start' && <section className="space-y-3 rounded-lg border p-4">
          <p className="font-semibold">{w('devPilotReadyToStart')}</p>
          <p className="text-sm text-muted-foreground">{w('devPilotStartDescription')}</p>
          {needsDuplicateReview && !duplicateAck &&
            <p className="text-xs text-amber-600 dark:text-amber-400">{w('devPilotMustReviewDuplicates')}</p>}
          <Button disabled={running || !canStart} onClick={() => void submit('activate')}>
            <Play className="me-2 size-4" />{w('devPilotActivate')}
          </Button>
        </section>}

        {step === 'active' && <section className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-5" />{w('devPilotNowActive')}</p>
          <p className="text-sm text-muted-foreground">{w('devPilotSendOneMessage')}</p>
          <Button variant="destructive" disabled={running} onClick={() => void submit('stop')}>
            <Square className="me-2 size-4" />{w('devPilotStop')}
          </Button>
        </section>}

        {step !== 'active' && (state.configured || state.active_admissions > 0 || !state.paused) &&
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={running} onClick={() => void submit('stop')}>
              <Square className="me-2 size-4" />{w('devPilotStop')}
            </Button>
            {verified && <Button size="sm" variant="ghost" disabled={running}
              onClick={() => void verifyGateway()}><RefreshCw className="me-2 size-4" />{w('devPilotReverify')}</Button>}
          </div>}

        {state.pilot_enabled && state.configured && <details className="rounded-lg border px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium">
            <span className="flex items-center gap-2"><SlidersHorizontal className="size-4" />{w('devPilotAdvanced')}</span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">{w('devPilotLimitsHelp')}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {([
              ['hourly_cap', 'devPilotHourly', 1, 3],
              ['daily_cap', 'devPilotDaily', 1, 10],
              ['first_touch_daily_cap', 'devPilotFirstTouch', 0, 1],
              ['minimum_interval_ms', 'devPilotInterval', 15000, 600000],
              ['jitter_ms', 'devPilotJitter', 0, 600000],
            ] as const).map(([key, label, min, max]) =>
              <div key={key} className="space-y-1">
                <Label htmlFor={`pilot-${connectionId}-${key}`}>{w(label)}</Label>
                <Input id={`pilot-${connectionId}-${key}`} type="number" min={min} max={max}
                  value={limits[key]} disabled={running || !state.paused}
                  onChange={(e) => setLimits((prev) => ({ ...prev, [key]: Number(e.target.value) }))} />
              </div>,
            )}
          </div>
          <Button className="mt-3" size="sm" variant="outline" disabled={running || !state.paused}
            onClick={() => void submit('limits')}>{w('devPilotSaveLimits')}</Button>
        </details>}

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{w('devPilotStopHint')}</span>
          <Button size="sm" variant="ghost" disabled={running}
            onClick={() => { setLoading(true); void load() }}>
            <RefreshCw className="me-2 size-3" />{w('refresh')}
          </Button>
        </div>
      </>}
    </CardContent>
  </Card>
}
