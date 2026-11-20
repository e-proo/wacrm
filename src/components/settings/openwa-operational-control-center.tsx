'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertCircle, ArrowDownUp, CheckCircle2, Clock3, FileCheck2,
  History, Loader2, LockKeyhole, RefreshCw, Shield, ShieldAlert,
  ShieldCheck, ShieldOff, SlidersHorizontal,
} from 'lucide-react'

import { useAuth } from '@/hooks/use-auth'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getWhatsAppAdminCopy } from './whatsapp-admin-copy'

const API = '/api/whatsapp/connections/openwa/operational-policy'
type PolicyState = {
  approved: boolean
  version: string | null
  digest: string | null
  terms: { ar: string; en: string } | null
}
type ConsentState = {
  status: 'accepted' | 'revoked' | 'missing'
  current: boolean
  policy_version: string | null
  revision: number
  updated_at: string | null
}
type ConnectionState = {
  connection_id: string
  display_name: string
  session_status: string
  session_ready: boolean
  requested_activation: 'enabled' | 'disabled' | 'suspended'
  activation_revision: number
  activation_updated_at: string | null
  reason: string
  send_authorized: false
}
type ConsentEvent = {
  action: 'accept' | 'revoke'
  actor_id: string
  revision: number
  recorded_at: string
  policy_version: string
}
type ActivationEvent = {
  connection_id: string
  actor_id: string
  previous_status: string
  new_status: string
  revision: number
  recorded_at: string
}
type OperationalState = {
  provider: 'openwa'
  operational_gate: 'legacy_test' | 'enforce_test' | 'enforce_release'
  deployment_release_enabled: boolean
  production_send_authorized: false
  policy: PolicyState
  consent: ConsentState
  mutation_stage: { owner_accept_available: boolean; connection_enable_available: boolean }
  connections: ConnectionState[]
  audit: { consent: ConsentEvent[]; activation: ActivationEvent[]; truncated_to: number }
}
type Operation = 'accept' | 'revoke' | 'enable' | 'disable' | 'suspend'
type Confirmation = {
  action: Operation
  connectionId?: string
  connectionName?: string
  revision: number
}
type RequestRecord = { fingerprint: string; requestId: string }

/** Do not mistake a partial/failed API response for "no connections" or
 * absence of consent. A failure is an explicit unavailable state. */
export function isOperationalControlResponse(value: unknown): value is OperationalState {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<OperationalState>
  return row.provider === 'openwa' && row.production_send_authorized === false &&
    Boolean(row.policy && typeof row.policy.approved === 'boolean' &&
      row.consent && typeof row.consent.revision === 'number' &&
      row.mutation_stage && typeof row.mutation_stage.connection_enable_available === 'boolean') &&
    Array.isArray(row.connections) && Boolean(row.audit &&
      Array.isArray(row.audit.consent) && Array.isArray(row.audit.activation))
}

export function OpenWAOperationalControlCenter() {
  const locale = useLocale()
  const ar = locale.startsWith('ar')
  const copy = getWhatsAppAdminCopy(locale).ops
  const { accountId, canEditSettings, isOwner } = useAuth()
  const [section, setSection] = useState<'policy' | 'connections' | 'audit'>('policy')
  const [data, setData] = useState<OperationalState | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [pendingRetry, setPendingRetry] = useState<RequestRecord | null>(null)
  const loadSeq = useRef(0)
  const mutationLock = useRef(false)
  const requestRecord = useRef<RequestRecord | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!canEditSettings || !accountId) {
      setData(null)
      setLoading(false)
      return
    }
    const seq = ++loadSeq.current
    if (quiet) setRefreshing(true)
    else { setLoading(true); setData(null) }
    try {
      const response = await fetch(API, { method: 'GET', cache: 'no-store' })
      const payload: unknown = await response.json()
      if (!response.ok || !isOperationalControlResponse(payload)) {
        const code = typeof payload === 'object' && payload !== null &&
          'code' in payload ? String((payload as { code?: unknown }).code) : 'unknown'
        throw new Error(code)
      }
      if (seq !== loadSeq.current) return
      setData(payload)
      setError(null)
    } catch (cause) {
      if (seq !== loadSeq.current) return
      setData(null)
      setError(cause instanceof Error ? cause.message : 'unknown')
    } finally {
      if (seq === loadSeq.current) { setLoading(false); setRefreshing(false) }
    }
  }, [accountId, canEditSettings])

  useEffect(() => {
    setError(null)
    setData(null)
    setLoading(true)
    setConfirmation(null)
    setPendingRetry(null)
    requestRecord.current = null
    void load()
    return () => { loadSeq.current++ }
  }, [load])

  const eventRows = useMemo(() => {
    if (!data) return []
    const names = new Map(data.connections.map(item => [item.connection_id, item.display_name]))
    return [
      ...data.audit.consent.map(event => ({
        key: 'consent:' + event.actor_id + ':' + event.revision,
        action: event.action,
        target: copy.account,
        actor: event.actor_id,
        date: event.recorded_at,
        revision: event.revision,
      })),
      ...data.audit.activation.map(event => ({
        key: 'activation:' + event.connection_id + ':' + event.revision,
        action: event.new_status,
        target: names.get(event.connection_id) || event.connection_id.slice(0, 8),
        actor: event.actor_id,
        date: event.recorded_at,
        revision: event.revision,
      })),
    ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  }, [data, copy.account])

  function openConfirmation(value: Confirmation) {
    if (saving) return
    requestRecord.current = null
    setPendingRetry(null)
    setMutationError(null)
    setAcknowledged(false)
    setConfirmation(value)
  }

  async function commit() {
    if (!confirmation || !acknowledged || !accountId || mutationLock.current) return
    mutationLock.current = true
    setSaving(true)
    setMutationError(null)
    const { action, connectionId, revision } = confirmation
    const fingerprint = [accountId, action, connectionId || 'account', revision,
      data?.policy.version || 'no-version'].join(':')
    // If the previous network outcome was unknown, reuse exactly the same
    // request ID and revision. Never issue a blind second distinct mutation.
    if (requestRecord.current?.fingerprint !== fingerprint) {
      requestRecord.current = { fingerprint, requestId: crypto.randomUUID() }
    }
    const requestId = requestRecord.current.requestId
    const endpoint = connectionId
      ? '/api/whatsapp/connections/openwa/' + encodeURIComponent(connectionId) + '/operational-activation'
      : API
    const body = action === 'accept'
      ? { action, expected_revision: revision, request_id: requestId,
        policy_version: data?.policy.version, policy_digest: data?.policy.digest,
        acknowledge_risks: true }
      : action === 'enable'
        ? { action, expected_revision: revision, request_id: requestId, confirm_activation: true }
        : { action, expected_revision: revision, request_id: requestId }
    try {
      const response = await fetch(endpoint, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload: { code?: string; replayed?: boolean; applied?: boolean } =
        await response.json().catch(() => ({}))
      if (!response.ok) {
        if (payload.code === 'revision_conflict' || payload.code === 'request_conflict') {
          requestRecord.current = null
          setPendingRetry(null)
          setConfirmation(null)
          toast.error(copy.stale)
          await load(true)
          return
        }
        const known = payload.code &&
          payload.code in copy.errors ? payload.code as keyof typeof copy.errors : 'unknown'
        setMutationError(copy.errors[known])
        // A confirmed server rejection need not be retried with a fresh UUID.
        // Preserve the request identity nonetheless until refresh/close.
        return
      }
      if (payload.applied !== true && payload.replayed !== true) {
        setMutationError(copy.failed)
        setPendingRetry(requestRecord.current)
        return
      }
      requestRecord.current = null
      setPendingRetry(null)
      setConfirmation(null)
      setAcknowledged(false)
      toast.success(payload.replayed ? copy.replay : copy.success)
      await load(true)
    } catch {
      setMutationError(copy.failed)
      setPendingRetry(requestRecord.current)
    } finally {
      mutationLock.current = false
      setSaving(false)
    }
  }

  function time(value: string | null | undefined) {
    if (!value || !Number.isFinite(Date.parse(value))) return copy.noDate
    return new Date(value).toLocaleString(ar ? 'ar-YE' : 'en-GB', {
      dateStyle: 'medium', timeStyle: 'short',
    })
  }
  function status(value: string) {
    return copy.statuses[value as keyof typeof copy.statuses] || copy.statuses.unknown
  }
  function reason(value: string) {
    return copy.reasons[value as keyof typeof copy.reasons] || copy.reasons.unknown
  }

  if (!canEditSettings) {
    return <Alert><ShieldAlert className="size-4" /><AlertDescription>{copy.noAccess}</AlertDescription></Alert>
  }
  if (loading && !data) {
    return <section aria-busy="true" className="flex min-h-56 items-center justify-center gap-3 rounded-2xl border bg-card text-sm text-muted-foreground">
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />{copy.loading}
    </section>
  }
  if (error || !data) {
    return <Alert variant="destructive" className="rounded-xl">
      <AlertCircle className="size-4" />
      <AlertTitle>{copy.unavailable}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{copy.missingSchema}</p>
        <p className="text-xs">{copy.errors[error as keyof typeof copy.errors] || copy.errors.unknown}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="me-2 size-4" />{copy.retry}
        </Button>
      </AlertDescription>
    </Alert>
  }

  const canAccept = isOwner && data.mutation_stage.owner_accept_available &&
    data.policy.approved && Boolean(data.policy.terms) && !data.consent.current
  const canRevoke = isOwner && data.consent.status === 'accepted'
  const readyCount = data.connections.filter(c => c.session_ready).length
  const enabledCount = data.connections.filter(c => c.requested_activation === 'enabled').length
  const pendingCount = data.connections.filter(c => c.reason !== 'request_admission_required').length
  const mainReason = data.operational_gate === 'legacy_test' ? copy.testLegacy
    : data.operational_gate === 'enforce_test' ? copy.testEnforced : copy.productionGate
  const confirmCopy = confirmation?.action === 'accept' ? copy.acknowledgeAccept
    : ['revoke', 'suspend', 'disable'].includes(confirmation?.action || '')
      ? copy.acknowledgeDisable : copy.acknowledge
  const selectedName = confirmation?.connectionName || copy.account

  return <section className="space-y-5" aria-labelledby="openwa-operations-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h3 id="openwa-operations-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />{copy.title}
        </h3>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{copy.subtitle}</p>
      </div>
      <Button size="sm" variant="outline" disabled={refreshing || saving} onClick={() => void load(true)}>
        <RefreshCw className={'me-2 size-4 ' + (refreshing ? 'animate-spin' : '')} />
        {copy.refresh}
      </Button>
    </div>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-xs text-muted-foreground">{copy.state}</p>
        <p className="mt-2 flex items-center gap-2 text-base font-semibold">
          {data.consent.current ? <CheckCircle2 className="size-4 text-emerald-600" /> :
            <ShieldAlert className="size-4 text-amber-600" />}
          {data.consent.current ? copy.current :
            data.consent.status === 'accepted' ? copy.outdated : copy.missing}
        </p>
      </article>
      <article className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-xs text-muted-foreground">{copy.connections}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{data.connections.length}</p>
        <p className="text-xs text-muted-foreground">{copy.ready}: {readyCount}</p>
      </article>
      <article className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-xs text-muted-foreground">{copy.requested}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{enabledCount}</p>
        <p className="text-xs text-muted-foreground">{copy.notAuthorized}</p>
      </article>
      <article className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-xs text-muted-foreground">{copy.safety}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{pendingCount}</p>
        <p className="text-xs text-muted-foreground">{mainReason}</p>
      </article>
    </div>

    <Alert className="border-amber-500/25 bg-amber-500/5">
      <ShieldAlert className="size-4" />
      <AlertTitle>{copy.pending}</AlertTitle>
      <AlertDescription>{copy.pendingDesc}</AlertDescription>
    </Alert>

    <Tabs value={section} onValueChange={v => setSection(v as typeof section)}>
      <div className="max-w-full overflow-x-auto pb-1">
        <TabsList variant="line" className="min-w-max border-b">
          <TabsTrigger value="policy" className="min-h-10 px-4"><FileCheck2 className="me-1 size-4" />{copy.policy}</TabsTrigger>
          <TabsTrigger value="connections" className="min-h-10 px-4"><SlidersHorizontal className="me-1 size-4" />{copy.connections}</TabsTrigger>
          <TabsTrigger value="audit" className="min-h-10 px-4"><History className="me-1 size-4" />{copy.audit}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="policy" className="space-y-4 pt-4">
        <Card className="border-border/75">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LockKeyhole className="size-4" />{copy.approved}
            </CardTitle>
            <CardDescription>{copy.contractNotice}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border bg-muted/20 p-4">
                <p className="text-xs text-muted-foreground">{copy.version}</p>
                <p className="mt-1 break-words font-medium">{data.policy.version || copy.approvedNone}</p>
                {data.policy.digest && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {copy.digest}: {data.policy.digest.slice(0, 12)}…
                </p>}
              </div>
              <div className="rounded-xl border bg-muted/20 p-4">
                <p className="text-xs text-muted-foreground">{copy.state}</p>
                <p className="mt-1 font-medium">{status(data.consent.status)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {copy.revision}: {data.consent.revision} · {time(data.consent.updated_at)}
                </p>
              </div>
            </div>
            {data.policy.terms ? <div className="rounded-xl border p-4">
              <p className="mb-3 text-sm font-semibold">{copy.reviewRisk}</p>
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-7">
                {ar ? data.policy.terms.ar : data.policy.terms.en}
              </div>
            </div> : <Alert>
              <ShieldOff className="size-4" />
              <AlertDescription>{data.policy.approved ? copy.noApprovedText : copy.previewOnly}</AlertDescription>
            </Alert>}
            <div className="flex flex-wrap items-center gap-2">
              {isOwner && <Button type="button" disabled={!canAccept || saving}
                onClick={() => openConfirmation({ action: 'accept', revision: data.consent.revision })}>
                <FileCheck2 className="me-2 size-4" />{copy.accept}
              </Button>}
              {canRevoke && <Button type="button" variant="destructive" disabled={saving}
                onClick={() => openConfirmation({ action: 'revoke', revision: data.consent.revision })}>
                <ShieldOff className="me-2 size-4" />{copy.revoke}
              </Button>}
            </div>
            {!data.mutation_stage.owner_accept_available && <p className="text-xs text-muted-foreground">{copy.guardDisabled}</p>}
            {!isOwner && <p className="text-xs text-muted-foreground">{copy.ownerRequired}</p>}
          </CardContent>
        </Card>
        <div className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          <p><Shield className="me-2 inline size-4" />{mainReason}</p>
          <p className="mt-2">{copy.release}: {
            data.deployment_release_enabled ? copy.releaseOn : copy.releaseOff
          }</p>
          <p className="mt-2">{copy.metaDefault}</p>
        </div>
      </TabsContent>

      <TabsContent value="connections" className="space-y-3 pt-4">
        <p className="text-sm leading-6 text-muted-foreground">{copy.adminRights}</p>
        {data.connections.length === 0 && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {copy.none}
        </div>}
        <div className="grid gap-3 lg:grid-cols-2">
          {data.connections.map(connection => {
            const canEnable = data.mutation_stage.connection_enable_available &&
              data.policy.approved && data.consent.current && connection.session_ready &&
              !(connection.requested_activation === 'enabled' &&
                connection.reason === 'request_admission_required')
            const canSuspend = connection.requested_activation === 'enabled'
            const canDisable = connection.requested_activation !== 'disabled'
            return <Card key={connection.connection_id} className="min-w-0 border-border/70">
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="max-w-full truncate text-base">{connection.display_name}</CardTitle>
                  <Badge variant={connection.session_ready ? 'secondary' : 'outline'}>
                    {connection.session_ready ? copy.ready : copy.notReady}
                  </Badge>
                </div>
                <CardDescription className="break-all text-xs">
                  {connection.connection_id.slice(0, 8)} · {connection.session_status}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/35 p-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{copy.requested}</p>
                    <p className="text-sm font-semibold">{status(connection.requested_activation)}</p>
                  </div>
                  <Badge variant="outline">{copy.revision}: {connection.activation_revision}</Badge>
                </div>
                <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                  {connection.reason === 'request_admission_required'
                    ? <CheckCircle2 className="mt-1 size-4 shrink-0 text-primary" />
                    : <AlertCircle className="mt-1 size-4 shrink-0 text-amber-600" />}
                  {reason(connection.reason)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={!canEnable || saving}
                    onClick={() => openConfirmation({ action: 'enable',
                      connectionId: connection.connection_id, connectionName: connection.display_name,
                      revision: connection.activation_revision })}>
                    <ShieldCheck className="me-1.5 size-4" />{copy.enable}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={!canSuspend || saving}
                    onClick={() => openConfirmation({ action: 'suspend',
                      connectionId: connection.connection_id, connectionName: connection.display_name,
                      revision: connection.activation_revision })}>
                    <Clock3 className="me-1.5 size-4" />{copy.suspend}
                  </Button>
                  <Button type="button" size="sm" variant="destructive" disabled={!canDisable || saving}
                    onClick={() => openConfirmation({ action: 'disable',
                      connectionId: connection.connection_id, connectionName: connection.display_name,
                      revision: connection.activation_revision })}>
                    <ShieldOff className="me-1.5 size-4" />{copy.disable}
                  </Button>
                </div>
                {!data.mutation_stage.connection_enable_available && <p className="text-xs text-muted-foreground">
                  {copy.guardDisabled}
                </p>}
              </CardContent>
            </Card>
          })}
        </div>
      </TabsContent>

      <TabsContent value="audit" className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 font-semibold">
            <ArrowDownUp className="size-4 text-muted-foreground" />{copy.history}
          </h4>
          <Badge variant="outline">{eventRows.length} / {data.audit.truncated_to * 2}</Badge>
        </div>
        {eventRows.length === 0 && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {copy.noAudit}
        </div>}
        {eventRows.length > 0 && <div className="overflow-hidden rounded-xl border">
          <div className="hidden grid-cols-[1.2fr_1.5fr_1.2fr_1fr] gap-3 border-b bg-muted/35 px-4 py-3 text-xs font-medium text-muted-foreground md:grid">
            <span>{copy.action}</span><span>{copy.target}</span>
            <span>{copy.actor}</span><span>{copy.when}</span>
          </div>
          <div className="divide-y">
            {eventRows.map(row => <div key={row.key}
              className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1.2fr_1.5fr_1.2fr_1fr] md:items-center md:gap-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{status(row.action)}</Badge>
                <span className="text-xs text-muted-foreground">#{row.revision}</span>
              </div>
              <span className="break-words">{row.target}</span>
              <span className="font-mono text-xs text-muted-foreground" title={row.actor}>
                {row.actor.slice(0, 8)}…
              </span>
              <time className="text-xs text-muted-foreground" dateTime={row.date}>{time(row.date)}</time>
            </div>)}
          </div>
        </div>}
      </TabsContent>
    </Tabs>

    <Dialog open={confirmation !== null} onOpenChange={open => {
      if (!open && !saving) {
        setConfirmation(null); setAcknowledged(false)
        setMutationError(null); setPendingRetry(null)
        requestRecord.current = null
      }
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-600" />{copy.actionConfirm}
          </DialogTitle>
          <DialogDescription>{selectedName} · {confirmation && ({
            accept: copy.accept, revoke: copy.revoke,
            enable: copy.enable, disable: copy.disable, suspend: copy.suspend,
          }[confirmation.action])}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {confirmation?.action === 'accept' && data.policy.terms && <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 text-sm leading-6">
            {ar ? data.policy.terms.ar : data.policy.terms.en}
          </div>}
          <Alert><ShieldAlert className="size-4" /><AlertDescription>{confirmCopy}</AlertDescription></Alert>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-6">
            <Checkbox checked={acknowledged} disabled={saving}
              onCheckedChange={checked => setAcknowledged(checked === true)} aria-label={confirmCopy} />
            <span>{confirmCopy}</span>
          </label>
          {mutationError && <Alert variant="destructive"><AlertCircle className="size-4" />
            <AlertDescription>{mutationError}</AlertDescription></Alert>}
          {pendingRetry && <p className="text-xs text-muted-foreground">{copy.failed}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => {
            setConfirmation(null); setAcknowledged(false)
            setMutationError(null); setPendingRetry(null)
            requestRecord.current = null
          }}>{copy.cancel}</Button>
          <Button type="button" disabled={!acknowledged || saving} onClick={() => void commit()}
            variant={confirmation?.action === 'revoke' || confirmation?.action === 'disable' ? 'destructive' : 'default'}>
            {saving && <Loader2 className="me-2 size-4 animate-spin" />}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
