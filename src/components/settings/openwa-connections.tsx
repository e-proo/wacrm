'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { Loader2, LogOut, QrCode, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { useWhatsAppLabels } from './whatsapp-labels'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface OpenWAConnection {
  id: string
  display_name: string | null
  phone_identity: string | null
  status: string
  session_id: string | null
  engine: string | null
}

interface QrState { connectionId: string; value: string; expiresAt: string }

export function OpenWAConnections() {
  const { canEditSettings } = useAuth()
  const w = useWhatsAppLabels()
  const [connections, setConnections] = useState<OpenWAConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [displayName, setDisplayName] = useState('WhatsApp Web')
  const [qr, setQr] = useState<QrState | null>(null)

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
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || w('loadOpenwa'))
      setConnections(data.connections ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('loadOpenwa'))
    } finally {
      setLoading(false)
    }
  }, [canEditSettings])

  useEffect(() => { void load() }, [load])

  async function createConnection() {
    if (!baseUrl.trim() || !apiKey.trim()) return toast.error(w('required'))
    setBusy('create')
    try {
      const response = await fetch('/api/whatsapp/connections/openwa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim(), display_name: displayName.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || w('createFailed'))
      setApiKey('')
      toast.success(w('created'))
      await load()
      await showQr(data.connection.id)
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
        const data = await response.json()
        if (response.ok) {
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

  async function action(connectionId: string, actionName: 'refresh' | 'reconnect' | 'logout') {
    setBusy(`${actionName}:${connectionId}`)
    try {
      const response = await fetch(`/api/whatsapp/connections/openwa/${connectionId}`, {
        method: actionName === 'logout' ? 'DELETE' : actionName === 'reconnect' ? 'POST' : 'GET',
        headers: actionName === 'reconnect' ? { 'Content-Type': 'application/json' } : undefined,
        body: actionName === 'reconnect' ? JSON.stringify({ action: 'reconnect' }) : undefined,
        cache: 'no-store',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || w('actionFailed'))
      if (actionName === 'logout') setQr(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : w('actionFailed'))
    } finally { setBusy(null) }
  }

  if (!canEditSettings) return null
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>

  return <div className="mt-6 space-y-4">
    <Card>
      <CardHeader><CardTitle>WhatsApp Web (OpenWA)</CardTitle><CardDescription>{w('openwaDesc')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Alert><AlertTitle>{w('onboarding')}</AlertTitle><AlertDescription>{w('onboardingDesc')}</AlertDescription></Alert>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label htmlFor="openwa-name">{w('name')}</Label><Input id="openwa-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
          <div><Label htmlFor="openwa-url">{w('baseUrl')}</Label><Input id="openwa-url" placeholder="https://openwa.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
          <div><Label htmlFor="openwa-key">{w('apiKey')}</Label><Input id="openwa-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
        </div>
        <Button onClick={createConnection} disabled={busy === 'create'}>{busy === 'create' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{w('create')}</Button>
      </CardContent>
    </Card>

    {connections.map((connection) => <Card key={connection.id}>
      <CardHeader><CardTitle className="text-base">{connection.display_name || 'WhatsApp Web'}</CardTitle><CardDescription>{w('status')} {(['creating', 'waiting_qr', 'authenticating', 'ready', 'connected', 'disconnected', 'failed', 'logged_out'] as const).includes(connection.status as 'ready') ? w(connection.status as 'creating' | 'waiting_qr' | 'authenticating' | 'ready' | 'connected' | 'disconnected' | 'failed' | 'logged_out') : connection.status}{connection.phone_identity ? ` · ${connection.phone_identity}` : ''}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => action(connection.id, 'refresh')}><RefreshCw className="mr-2 h-4 w-4" />{w('refresh')}</Button>
          {['creating', 'waiting_qr', 'authenticating', 'disconnected'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => showQr(connection.id)}><QrCode className="mr-2 h-4 w-4" />{w('showQr')}</Button>}
          {['ready', 'connected', 'disconnected', 'failed'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'reconnect')}><RotateCcw className="mr-2 h-4 w-4" />{w('reconnect')}</Button>}
          {connection.status !== 'logged_out' && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'logout')}><LogOut className="mr-2 h-4 w-4" />{w('logout')}</Button>}
        </div>
        {qr?.connectionId === connection.id && <div className="rounded-md border p-4">
          <p className="mb-3 text-sm font-medium">{w('qrPayload')}</p>
          <Image src={qr.value} alt={w('qrPayload')} width={256} height={256} unoptimized className="rounded bg-white p-2" />
          <p className="mt-2 text-xs text-muted-foreground">{w('expires')} {new Date(qr.expiresAt).toLocaleTimeString()}. {w('qrHint')}</p>
        </div>}
      </CardContent>
    </Card>)}
  </div>
}
