'use client'

import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseOpenWAApiResponse } from '@/lib/whatsapp/transport/openwa/browser-api-response'
import { useWhatsAppLabels } from './whatsapp-labels'

interface PilotState extends Record<string, unknown> {
  connectionId: string
  status: string
  enforced: boolean
  configured: boolean
  active: boolean
  paused: boolean
  active_admissions: number
  unsettled_outbound: number
  same_identity_ready_connections: number
  guardrails: {
    hourly_cap: number
    daily_cap: number
    first_touch_daily_cap: number
    minimum_interval_ms: number
    jitter_ms: number
  }
  error?: string
}

const defaultLimits = { hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
  minimum_interval_ms: 15000, jitter_ms: 3000 }

export function OpenWAPilotControls({ connectionId }: { connectionId: string }) {
  const w = useWhatsAppLabels()
  const [state, setState] = useState<PilotState | null>(null)
  const [limits, setLimits] = useState(defaultLimits)
  const [recipient, setRecipient] = useState('')
  const [consent, setConsent] = useState(false)
  const [duplicateAck, setDuplicateAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/pilot`

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      const data = await parseOpenWAApiResponse<PilotState>(res)
      if (!res.ok) throw new Error(data.error || 'Pilot status unavailable')
      setState(data)
      setLimits({ hourly_cap: data.guardrails.hourly_cap, daily_cap: data.guardrails.daily_cap,
        first_touch_daily_cap: data.guardrails.first_touch_daily_cap,
        minimum_interval_ms: data.guardrails.minimum_interval_ms, jitter_ms: data.guardrails.jitter_ms })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pilot status unavailable')
      setState(null)
    } finally { setLoading(false) }
  }, [endpoint])

  useEffect(() => { void load() }, [load])

  async function submit(action: 'prepare' | 'limits' | 'grant' | 'activate' | 'stop') {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = { action }
      if (action === 'prepare') body.confirm_prepare = true
      if (action === 'limits') Object.assign(body, limits)
      if (action === 'grant') Object.assign(body, { recipient: recipient.trim(), consent_confirmed: consent,
        ack_duplicate_sessions: duplicateAck, hours: 4 })
      if (action === 'activate') body.ack_duplicate_sessions = duplicateAck
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store',
      })
      const data = await parseOpenWAApiResponse<PilotState>(res)
      if (!res.ok) throw new Error(data.error || 'Pilot action rejected')
      setState(data)
      if (action === 'grant') { setRecipient(''); setConsent(false) }
      setNotice(w(action === 'prepare' ? 'devPilotPrepared' : action === 'stop' ? 'devPilotStopped'
        : action === 'activate' ? 'devPilotStarted'
        : action === 'grant' ? 'devPilotGranted' : 'devPilotLimitsSaved'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pilot operation rejected')
    } finally { setBusy(false) }
  }

  return <Card className="mt-4 border-dashed">
    <CardHeader><CardTitle className="text-base">{w('devPilotTitle')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {loading && <p className="text-sm text-muted-foreground">{w('devPilotLoading')}</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      {state && <>
        <Alert variant={state.enforced ? 'default' : 'destructive'}>
          <AlertTitle>{w(state.enforced ? 'pilotEnforceOn' : 'pilotEnforceOff')}</AlertTitle>
          <AlertDescription>{w('devPilotRuntimeNote')}</AlertDescription>
        </Alert>
        <p className="text-sm">{w('devPilotState')}: <strong>{state.active ? w('devPilotActive') : w('devPilotInactive')}</strong>
          {' · '}{w('devPilotPaused')}: {state.paused ? w('devPilotYes') : w('devPilotNo')}
          {' · '}{w('devPilotGrants')}: {state.active_admissions}
          {' · '}{w('devPilotPending')}: {state.unsettled_outbound}</p>
        {state.same_identity_ready_connections > 1 && <Alert variant="destructive">
          <AlertDescription>{w('devPilotDuplicateWarning')} ({state.same_identity_ready_connections})</AlertDescription>
        </Alert>}
        {!state.configured && <Alert>
          <AlertTitle>{w('devPilotNeedsSetup')}</AlertTitle>
          <AlertDescription>{w('devPilotSetupHint')}</AlertDescription>
        </Alert>}
        {!state.configured && <Button type="button" variant="outline"
          disabled={busy || !['ready', 'connected'].includes(state.status) || state.unsettled_outbound !== 0}
          onClick={() => void submit('prepare')}>{w('devPilotPrepare')}</Button>}
        {state.configured && <>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ['hourly_cap','devPilotHourly',1,3],
            ['daily_cap','devPilotDaily',1,10],
            ['first_touch_daily_cap','devPilotFirstTouch',0,1],
            ['minimum_interval_ms','devPilotInterval',15000,600000],
            ['jitter_ms','devPilotJitter',0,600000],
          ] as const).map(([key,label,min,max]) => <div key={key} className="space-y-1">
            <Label htmlFor={`pilot-${connectionId}-${key}`}>{w(label)}</Label>
            <Input id={`pilot-${connectionId}-${key}`} type="number" min={min} max={max}
              value={limits[key]} disabled={busy || !state.paused}
              onChange={(e) => setLimits((prev) => ({ ...prev, [key]: Number(e.target.value) }))}/>
          </div>)}
        </div>
        <Button type="button" variant="outline" disabled={busy || !state.paused} onClick={() => void submit('limits')}>
          {w('devPilotSaveLimits')}
        </Button>
        <div className="space-y-2">
          <Label htmlFor={`pilot-recipient-${connectionId}`}>{w('devPilotRecipient')}</Label>
          <Input id={`pilot-recipient-${connectionId}`} type="text" autoComplete="off"
            placeholder="12345678901 or 123456789@lid" value={recipient}
            disabled={busy || !state.paused}
            onChange={(e) => setRecipient(e.target.value)}/>
          <p className="text-xs text-muted-foreground">{w('devPilotRecipientHint')}</p>
          <div className="flex items-center gap-2">
            <Checkbox id={`pilot-consent-${connectionId}`} checked={consent} disabled={busy || !state.paused}
              onCheckedChange={(checked) => setConsent(checked === true)}/>
            <Label htmlFor={`pilot-consent-${connectionId}`}>{w('devPilotConsent')}</Label>
          </div>
          {state.same_identity_ready_connections > 1 && <div className="flex items-center gap-2">
            <Checkbox id={`pilot-duplicates-${connectionId}`} checked={duplicateAck} disabled={busy}
              onCheckedChange={(checked) => setDuplicateAck(checked === true)}/>
            <Label htmlFor={`pilot-duplicates-${connectionId}`}>{w('devPilotDuplicateAck')}</Label>
          </div>}
          <Button type="button" variant="outline"
            disabled={busy || !state.enforced || !state.paused || !consent || !recipient.trim() ||
              (state.same_identity_ready_connections > 1 && !duplicateAck)}
            onClick={() => void submit('grant')}>{w('devPilotGrant')}</Button>
        </div>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy || !state.configured || !state.enforced || !state.paused ||
            state.active_admissions !== 1 || state.unsettled_outbound !== 0 ||
            (state.same_identity_ready_connections > 1 && !duplicateAck)}
            onClick={() => void submit('activate')}>{w('devPilotActivate')}</Button>
          <Button type="button" variant="destructive" disabled={busy}
            onClick={() => void submit('stop')}>{w('devPilotStop')}</Button>
          <Button type="button" variant="outline" disabled={busy}
            onClick={() => { setLoading(true); void load() }}>{w('refresh')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{w('devPilotStopHint')}</p>
      </>}
    </CardContent>
  </Card>
}
