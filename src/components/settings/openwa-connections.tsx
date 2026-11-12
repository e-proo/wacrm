'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Loader2, LogOut, Pause, Play, QrCode, RefreshCw, RotateCcw, Trash2, Webhook } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { parseOpenWAApiResponse } from '@/lib/whatsapp/transport/openwa/browser-api-response'
import { useWhatsAppLabels } from './whatsapp-labels'
import { OpenWAPilotControls } from './openwa-pilot-controls'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface OpenWAConnection {
  id: string
  display_name: string | null
  phone_identity: string | null
  status: string
  session_id: string | null
  engine: string | null
  guardrail?: { manual_paused: boolean }
  provider_metadata?: {
    onboarding_stage?: string
    onboarding_failure_code?: string
    onboarding_reconciliation_required?: boolean
  } | null
}

interface QrState { connectionId: string; value: string; expiresAt: string }
interface OpenWAApiPayload extends Record<string, unknown> {
  error?: string
  code?: string
  reachable?: boolean
  stage?: string
  reconciliation_required?: boolean
  connections?: OpenWAConnection[]
  pilot?: { enforced: boolean; devMode: boolean; automaticallyEnforced?: boolean }
  connection?: { id: string }
  qr?: string
  expires_at?: string
  removed?: boolean
}

export function OpenWAConnections() {
  const { canEditSettings } = useAuth()
  const w = useWhatsAppLabels()
  const [connections, setConnections] = useState<OpenWAConnection[]>([])
  const [pilotEnforced, setPilotEnforced] = useState<boolean | null>(null)
  const [pilotDevMode, setPilotDevMode] = useState(false)
  const [selectedPilotId, setSelectedPilotId] = useState('')
  const pilotSectionRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [displayName, setDisplayName] = useState('WhatsApp Web')
  const [qr, setQr] = useState<QrState | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<OpenWAConnection | null>(null)

  useEffect(() => {
    if (!qr) return
    const expiresIn = Date.parse(qr.expiresAt) - Date.now()
    if (expiresIn <= 0) { setQr(null); return }
    const timer = setTimeout(() => setQr((current) => current?.value === qr.value ? null : current), expiresIn)
    return () => clearTimeout(timer)
  }, [qr])

  const load = useCallback(async () => {
    if (!canEditSettings) { setLoading(false); return }
    try {
      const response = await fetch('/api/whatsapp/connections/openwa', { cache: 'no-store' })
      const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
      if (!response.ok) throw new Error(data.error || w('loadOpenwa'))
      const available = data.connections ?? []
      setConnections(available)
      setSelectedPilotId((current) => available.some((c) => c.id === current) ? current
        : (available.find((c) => ['ready', 'connected'].includes(c.status))?.id ?? available[0]?.id ?? ''))
      setPilotEnforced(typeof data.pilot?.enforced === 'boolean' ? data.pilot.enforced : null)
      setPilotDevMode(data.pilot?.devMode === true)
      setLoadError(null)
    } catch (error) {
      const reason = error instanceof Error ? error.message : w('loadOpenwa')
      setLoadError(reason)
      setPilotEnforced(null)
      setPilotDevMode(false)
      toast.error(reason)
    } finally {
      setLoading(false)
    }
  }, [canEditSettings])

  useEffect(() => { void load() }, [load])

  function focusPilot(connectionId: string) {
    setSelectedPilotId(connectionId)
    pilotSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function checkGateway() {
    if (!baseUrl.trim() || !apiKey.trim()) return toast.error(w('required'))
    setBusy('check')
    try {
      const response = await fetch('/api/whatsapp/connections/openwa/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim() }),
      })
      const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
      if (!response.ok || !data.reachable) throw new Error(data.error || w('gatewayCheckFailed'))
      toast.success(w('gatewayCheckSuccess'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('gatewayCheckFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function createConnection() {
    if (!baseUrl.trim() || !apiKey.trim()) return toast.error(w('required'))
    setBusy('create')
    try {
      const response = await fetch('/api/whatsapp/connections/openwa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim(), display_name: displayName.trim() }),
      })
      const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
      if (!response.ok) {
        // Failure after POST /sessions may still leave an upstream session.
        // Do not invite the user to click "Create" blindly; reconcile first.
        const reason = data.error || w('createFailed')
        const stage = typeof data.stage === 'string' && /^[a-z_]{1,40}$/.test(data.stage) ? data.stage : 'unknown'
        const warning = data.reconciliation_required
          ? ' Check the existing OpenWA session list and gateway before attempting creation again.'
          : ''
        throw new Error(`${reason} (stage=${stage}).${warning}`)
      }
      setApiKey('')
      toast.success(w('created'))
      await load()
      if (data.connection?.id) await showQr(data.connection.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('createFailed'))
    } finally { setBusy(null) }
  }

  async function showQr(connectionId: string) {
    setBusy(`qr:${connectionId}`)
    try {
      // Session startup is asynchronous. QR reads are safe to poll, unlike
      // retries of session creation or sending messages.
      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await fetch(`/api/whatsapp/connections/openwa/${connectionId}/qr`, { cache: 'no-store' })
        const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
        if (response.ok) {
          if (!data.qr || !data.expires_at) throw new Error(w('qrUnavailable'))
          setQr({ connectionId, value: data.qr, expiresAt: data.expires_at })
          return
        }
        if (attempt === 7 || (response.status !== 404 && response.status !== 409)) {
          throw new Error(data.error || w('qrUnavailable'))
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    } catch (error) {
      setQr(null)
      toast.error(error instanceof Error ? error.message : w('qrUnavailable'))
    } finally { setBusy(null) }
  }

  async function action(connectionId: string, actionName: 'refresh' | 'reconnect' | 'logout' | 'configure_webhook' | 'pause' | 'resume' | 'update_gateway') {
    if (actionName === 'update_gateway' && (!baseUrl.trim() || !apiKey.trim())) {
      toast.error(w('required'))
      return
    }
    setBusy(`${actionName}:${connectionId}`)
    try {
      const response = await fetch(`/api/whatsapp/connections/openwa/${connectionId}`, {
        method: actionName === 'logout' ? 'DELETE' : actionName === 'refresh' ? 'GET' : 'POST',
        headers: actionName !== 'refresh' && actionName !== 'logout' ? { 'Content-Type': 'application/json' } : undefined,
        body: actionName !== 'refresh' && actionName !== 'logout' ? JSON.stringify({ action: actionName,
          ...(actionName === 'update_gateway' ? { base_url: baseUrl.trim(), api_key: apiKey.trim() } : {}) }) : undefined,
        cache: 'no-store',
      })
      const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
      if (!response.ok) {
        const stage = typeof data.stage === 'string' && /^[a-z_]{1,40}$/.test(data.stage) ? data.stage : null
        throw new Error(`${data.error || w('actionFailed')}${stage ? ` (stage: ${stage})` : ''}`)
      }
      if (actionName === 'logout') setQr(null)
      if (actionName === 'configure_webhook') toast.success(w('webhookConfigured'))
      if (actionName === 'update_gateway') { setApiKey(''); toast.success(w('devPilotGatewayUpdated')) }
      if (actionName === 'pause') toast.success(w('sendingPaused'))
      if (actionName === 'resume') toast.success(w('sendingResumed'))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('actionFailed'))
    } finally { setBusy(null) }
  }

  async function removeConnection() {
    if (!pendingRemoval || busy !== null) return
    const connection = pendingRemoval
    setBusy(`remove:${connection.id}`)
    try {
      const response = await fetch(`/api/whatsapp/connections/openwa/${connection.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove_from_wacrm' }),
        cache: 'no-store',
      })
      const data = await parseOpenWAApiResponse<OpenWAApiPayload>(response)
      if (!response.ok || !data.removed) throw new Error(data.error || w('removeSessionFailed'))
      setPendingRemoval(null)
      setQr((current) => current?.connectionId === connection.id ? null : current)
      toast.success(w('removeSessionSuccess'))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('removeSessionFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (!canEditSettings) return null
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
  if (loadError) {
    // An unavailable API is not evidence that this tenant has zero sessions.
    // Never encourage admins to create duplicate sessions after a failed list.
    return <div className="mt-6 space-y-3">
      <Alert variant="destructive"><AlertTitle>{w('loadOpenwa')}</AlertTitle><AlertDescription>{loadError}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => { setLoading(true); void load() }}><RefreshCw className="mr-2 h-4 w-4" />{w('refresh')}</Button>
    </div>
  }

  return <div className="mt-6 space-y-4">
    <Card>
      <CardHeader><CardTitle>WhatsApp Web (OpenWA)</CardTitle><CardDescription>{w('openwaDesc')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Alert><AlertTitle>{w('onboarding')}</AlertTitle><AlertDescription>{w('onboardingDesc')}</AlertDescription></Alert>
        {pilotEnforced !== null && <Alert variant={pilotEnforced ? 'default' : 'destructive'}>
          <AlertTitle>{w(pilotEnforced ? 'pilotEnforceOn' : 'pilotEnforceOff')}</AlertTitle>
          <AlertDescription>{w(pilotEnforced ? 'pilotEnforceOnHint' : 'pilotEnforceOffHint')}</AlertDescription>
        </Alert>}
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label htmlFor="openwa-name">{w('name')}</Label><Input id="openwa-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
          <div><Label htmlFor="openwa-url">{w('baseUrl')}</Label><Input id="openwa-url" placeholder="https://openwa.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
          <div><Label htmlFor="openwa-key">{w('apiKey')}</Label><Input id="openwa-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
        </div>
        {baseUrl.toLowerCase().includes('.trycloudflare.com') && <Alert>
          <AlertDescription>{w('quickTunnelWarning')}</AlertDescription>
        </Alert>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={checkGateway} disabled={busy !== null}>
            {busy === 'check' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {w('gatewayCheck')}
          </Button>
          <Button onClick={createConnection} disabled={busy !== null}>{busy === 'create' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{w('create')}</Button>
        </div>
      </CardContent>
    </Card>

    {pilotDevMode && connections.length > 0 && <div ref={pilotSectionRef} className="space-y-3 scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{w('devPilotHubTitle')}</CardTitle>
          <CardDescription>{w('devPilotHubHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="openwa-pilot-selector">{w('devPilotChooseConnection')}</Label>
          <select id="openwa-pilot-selector" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedPilotId} onChange={(e) => setSelectedPilotId(e.target.value)}>
            {connections.map((c) => <option key={c.id} value={c.id}>
              {c.display_name || 'WhatsApp Web'} · {c.status} · {c.id.slice(0, 8)}
            </option>)}
          </select>
          {selectedPilotId && <p className="break-all text-xs text-muted-foreground">
            {w('connectionReference')}: {selectedPilotId}
            {' · '}{w('devPilotState')}: {connections.find((c) => c.id === selectedPilotId)?.status ?? 'unknown'}
          </p>}
          <p className="text-sm text-muted-foreground">{w('devPilotGatewayUpdateHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null || !selectedPilotId}
              onClick={() => { if (selectedPilotId) void action(selectedPilotId, 'refresh') }}>
              <RefreshCw className="mr-2 h-4 w-4" />{w('refresh')}
            </Button>
            <Button variant="outline" size="sm"
              disabled={busy !== null || !selectedPilotId || !baseUrl.trim() || !apiKey.trim() ||
                !connections.find((c) => c.id === selectedPilotId)?.session_id}
              onClick={() => { if (selectedPilotId) void action(selectedPilotId, 'update_gateway') }}>
              {w('devPilotGatewayUpdate')}
            </Button>
          </div>
        </CardContent>
      </Card>
      {selectedPilotId && <OpenWAPilotControls key={selectedPilotId} connectionId={selectedPilotId} />}
    </div>}

    {connections.map((connection) => <Card key={connection.id}>
      <CardHeader><CardTitle className="text-base">{connection.display_name || 'WhatsApp Web'}</CardTitle><CardDescription>{w('status')} {(['creating', 'waiting_qr', 'authenticating', 'ready', 'connected', 'disconnected', 'reconnecting', 'restricted', 'failed', 'logged_out'] as const).includes(connection.status as 'ready') ? w(connection.status as 'creating' | 'waiting_qr' | 'authenticating' | 'ready' | 'connected' | 'disconnected' | 'reconnecting' | 'restricted' | 'failed' | 'logged_out') : connection.status}{connection.phone_identity ? ` · ${connection.phone_identity}` : ''}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {connection.provider_metadata?.onboarding_reconciliation_required && <Alert variant="destructive">
          <AlertTitle>{w('reconciliationTitle')}</AlertTitle>
          <AlertDescription>
            {w('reconciliationDesc')}
            {connection.provider_metadata.onboarding_stage ? ` Stage: ${connection.provider_metadata.onboarding_stage}.` : ''}
            {connection.provider_metadata.onboarding_failure_code ? ` Code: ${connection.provider_metadata.onboarding_failure_code}.` : ''}
          </AlertDescription>
        </Alert>}
        {connection.phone_identity && connections.filter((item) => item.phone_identity === connection.phone_identity).length > 1 && <Alert>
          <AlertDescription>
            {w('duplicatePhoneNotice')}
            <span className="block mt-1 break-all text-xs">{w('connectionReference')}: {connection.id} · Session: {connection.session_id || '—'}</span>
          </AlertDescription>
        </Alert>}
        {connection.guardrail?.manual_paused && <Alert variant="destructive">
          <AlertTitle>{w('sendingPaused')}</AlertTitle>
          <AlertDescription>{w('pauseSendingHint')}</AlertDescription>
        </Alert>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => action(connection.id, 'refresh')}><RefreshCw className="mr-2 h-4 w-4" />{w('refresh')}</Button>
          {pilotDevMode && <Button variant="outline" size="sm" onClick={() => focusPilot(connection.id)}>
            {w('devPilotManageThisConnection')}
          </Button>}
          {pilotDevMode && connection.session_id && <Button variant="outline" size="sm"
            disabled={busy !== null || !baseUrl.trim() || !apiKey.trim()}
            onClick={() => action(connection.id, 'update_gateway')}>{w('devPilotGatewayUpdate')}</Button>}
          {['creating', 'waiting_qr', 'authenticating', 'disconnected'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => showQr(connection.id)}><QrCode className="mr-2 h-4 w-4" />{w('showQr')}</Button>}
          {['disconnected', 'failed'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'reconnect')}><RotateCcw className="mr-2 h-4 w-4" />{w('reconnect')}</Button>}
          {connection.session_id && connection.status !== 'logged_out' && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'configure_webhook')} disabled={busy === `configure_webhook:${connection.id}`}><Webhook className="mr-2 h-4 w-4" />{w('configureWebhook')}</Button>}
          {connection.status !== 'logged_out' && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'logout')}><LogOut className="mr-2 h-4 w-4" />{w('logout')}</Button>}
          {connection.guardrail?.manual_paused
            ? !pilotDevMode && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'resume')} disabled={busy !== null}>
                <Play className="mr-2 h-4 w-4" />{w('resumeSending')}
              </Button>
            : <Button variant="destructive" size="sm" onClick={() => action(connection.id, 'pause')}>
                <Pause className="mr-2 h-4 w-4" />{w('pauseSending')}
              </Button>}
          <Button variant="outline" size="sm" onClick={() => setPendingRemoval(connection)}
            disabled={busy !== null} className="text-destructive hover:text-destructive">
            <Trash2 className="mr-2 h-4 w-4" />{w('removeFromWacrm')}
          </Button>
        </div>
        {qr?.connectionId === connection.id && <div className="rounded-md border p-4">
          <p className="mb-3 text-sm font-medium">{w('qrPayload')}</p>
          <Image src={qr.value} alt={w('qrPayload')} width={256} height={256} unoptimized className="rounded bg-white p-2" />
          <p className="mt-2 text-xs text-muted-foreground">{w('expires')} {new Date(qr.expiresAt).toLocaleTimeString()}. {w('qrHint')}</p>
        </div>}
      </CardContent>
    </Card>)}
    <Dialog open={pendingRemoval !== null} onOpenChange={(open) => { if (!open && busy === null) setPendingRemoval(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{w('removeSessionTitle')}</DialogTitle>
          <DialogDescription>
            {pendingRemoval?.display_name || 'WhatsApp Web'}
            {pendingRemoval?.phone_identity ? ` · ${pendingRemoval.phone_identity}` : ''}
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>{w('removeSessionWarning')}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingRemoval(null)} disabled={busy !== null}>
            {w('removeSessionCancel')}
          </Button>
          <Button variant="destructive" onClick={() => void removeConnection()} disabled={busy !== null || !pendingRemoval}>
            {busy?.startsWith('remove:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {w('removeSessionConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
