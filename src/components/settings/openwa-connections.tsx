'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, LogOut, QrCode, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
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
  const [connections, setConnections] = useState<OpenWAConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [displayName, setDisplayName] = useState('WhatsApp Web')
  const [engine, setEngine] = useState<'baileys' | 'whatsapp-web.js'>('baileys')
  const [qr, setQr] = useState<QrState | null>(null)

  const load = useCallback(async () => {
    if (!canEditSettings) { setLoading(false); return }
    try {
      const response = await fetch('/api/whatsapp/connections/openwa', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to load WhatsApp Web connections')
      setConnections(data.connections ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load WhatsApp Web connections')
    } finally {
      setLoading(false)
    }
  }, [canEditSettings])

  useEffect(() => { void load() }, [load])

  async function createConnection() {
    if (!baseUrl.trim() || !apiKey.trim()) return toast.error('OpenWA URL and API key are required')
    setBusy('create')
    try {
      const response = await fetch('/api/whatsapp/connections/openwa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim(), display_name: displayName.trim(), engine }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to create WhatsApp Web session')
      setApiKey('')
      toast.success('WhatsApp Web session created. Scan its QR code to authenticate.')
      await load()
      await showQr(data.connection.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create WhatsApp Web session')
    } finally { setBusy(null) }
  }

  async function showQr(connectionId: string) {
    setBusy(`qr:${connectionId}`)
    try {
      const response = await fetch(`/api/whatsapp/connections/openwa/${connectionId}/qr`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'QR is not available')
      setQr({ connectionId, value: data.qr, expiresAt: data.expires_at })
    } catch (error) {
      setQr(null)
      toast.error(error instanceof Error ? error.message : 'QR is not available')
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
      if (!response.ok) throw new Error(data.error || `Failed to ${actionName} session`)
      if (actionName === 'logout') setQr(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to ${actionName} session`)
    } finally { setBusy(null) }
  }

  if (!canEditSettings) return null
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>

  return <div className="mt-6 space-y-4">
    <Card>
      <CardHeader><CardTitle>WhatsApp Web (OpenWA)</CardTitle><CardDescription>Optional self-hosted transport. Meta Cloud remains the default production provider.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Alert><AlertTitle>Admin-only onboarding</AlertTitle><AlertDescription>The API key is encrypted server-side. QR material is never stored by WACRM and expires quickly.</AlertDescription></Alert>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label htmlFor="openwa-name">Name</Label><Input id="openwa-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
          <div><Label htmlFor="openwa-engine">Engine</Label><select id="openwa-engine" className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}><option value="baileys">Baileys</option><option value="whatsapp-web.js">whatsapp-web.js</option></select></div>
          <div><Label htmlFor="openwa-url">OpenWA HTTPS URL</Label><Input id="openwa-url" placeholder="https://openwa.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
          <div><Label htmlFor="openwa-key">API key</Label><Input id="openwa-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
        </div>
        <Button onClick={createConnection} disabled={busy === 'create'}>{busy === 'create' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create WhatsApp Web session</Button>
      </CardContent>
    </Card>

    {connections.map((connection) => <Card key={connection.id}>
      <CardHeader><CardTitle className="text-base">{connection.display_name || 'WhatsApp Web'}</CardTitle><CardDescription>Status: {connection.status}{connection.phone_identity ? ` · ${connection.phone_identity}` : ''}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => action(connection.id, 'refresh')}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
          {['creating', 'waiting_qr', 'authenticating', 'disconnected'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => showQr(connection.id)}><QrCode className="mr-2 h-4 w-4" />Show QR</Button>}
          {['ready', 'connected', 'disconnected', 'failed'].includes(connection.status) && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'reconnect')}><RotateCcw className="mr-2 h-4 w-4" />Reconnect</Button>}
          {connection.status !== 'logged_out' && <Button variant="outline" size="sm" onClick={() => action(connection.id, 'logout')}><LogOut className="mr-2 h-4 w-4" />Log out</Button>}
        </div>
        {qr?.connectionId === connection.id && <div className="rounded-md border p-4"><p className="mb-2 text-sm font-medium">Short-lived QR payload</p><div className="break-all rounded bg-muted p-3 font-mono text-xs" aria-label="OpenWA QR payload">{qr.value}</div><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(qr.expiresAt).toLocaleTimeString()}. Refresh if your WhatsApp client cannot scan it.</p></div>}
      </CardContent>
    </Card>)}
  </div>
}
