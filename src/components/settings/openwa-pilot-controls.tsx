'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Play, RefreshCw, ShieldCheck, Square, SlidersHorizontal } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseOpenWAApiResponse } from '@/lib/whatsapp/transport/openwa/browser-api-response'
import { normalizeTestRecipient } from '@/lib/whatsapp/transport/openwa/pilot-recipient-input'
import { missingPilotCohortCaps, suggestedPilotCohortCaps, OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT, OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT, OPENWA_TEST_PILOT_MAX_HOURLY, OPENWA_TEST_PILOT_MAX_DAILY, OPENWA_TEST_PILOT_MAX_FIRST_TOUCH, OPENWA_TEST_PILOT_MIN_INTERVAL_MS, type PilotCohortWorkload } from '@/lib/whatsapp/transport/openwa/pilot-cohort-caps'
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
  approved_messages_per_recipient?: number | null
  required_cohort_messages?: number
  agent_admissions?: number
  manual_admissions?: number
  approved_workload?: 'manual' | 'agent' | null
  unsettled_outbound: number
  same_identity_ready_connections: number
  last_denial?: { workload: string; reason: string; created_at: string } | null
  error?: string
  guardrails: {
    hourly_cap: number
    daily_cap: number
    first_touch_daily_cap: number
    warmup_hourly_cap: number
    warmup_daily_cap: number
    minimum_interval_ms: number
    jitter_ms: number
    pilot_agent_hourly_cap?: number | null
    pilot_agent_daily_cap?: number | null
    pilot_manual_hourly_cap?: number | null
    pilot_manual_daily_cap?: number | null
  }
}

type RelatedConnection = { id: string; status: string; sessionId: string | null }
type PilotAction = 'prepare' | 'limits' | 'grant_batch' | 'activate' | 'stop' | 'disable' | 'enable'
type PilotStep = 'protected' | 'pending' | 'needsStop' | 'verify' | 'prepare' | 'approve' | 'start' | 'active' | 'multiple' | 'normal'

const capName: Record<string, string> = {
  hourly_cap: 'الحد الساعي للجلسة',
  daily_cap: 'الحد اليومي للجلسة',
  first_touch_daily_cap: 'حد أول تواصل يومي',
  warmup_hourly_cap: 'حد الإحماء الساعي',
  warmup_daily_cap: 'حد الإحماء اليومي',
  pilot_agent_hourly_cap: 'حد الوكيل الساعي',
  pilot_agent_daily_cap: 'حد الوكيل اليومي',
  pilot_manual_hourly_cap: 'حد الرسائل العادية الساعي',
  pilot_manual_daily_cap: 'حد الرسائل العادية اليومي',
  messages_per_recipient: 'رسائل لكل جهة: القيمة تتجاوز السقف الممكن للمجموعة',
}

const defaultLimits = { hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
  minimum_interval_ms: 15000, jitter_ms: 3000,
  pilot_agent_hourly_cap: 3, pilot_agent_daily_cap: 10,
  pilot_manual_hourly_cap: 3, pilot_manual_daily_cap: 10 }

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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [search, setSearch] = useState('')
  const [contactResults, setContactResults] = useState<Array<{ id: string; name: string | null; phone: string }>>([])
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [messagesPerRecipient, setMessagesPerRecipient] = useState(OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT)
  const [contactError, setContactError] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [phoneCallConsent, setPhoneCallConsent] = useState(false)
  const [duplicateAck, setDuplicateAck] = useState(false)
  const [adminAlertConsent, setAdminAlertConsent] = useState(false)
  const [trustedAdmins, setTrustedAdmins] = useState<Array<{ id: string; display_name: string | null; normalized_address: string; status: string; allowed_capabilities: string[] }>>([])
  const [verified, setVerified] = useState(false)
  const [verifiedStatus, setVerifiedStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/pilot`
  const normalizedRecipient = useMemo(() => normalizeTestRecipient(recipient), [recipient])

  useEffect(() => {
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        // The existing admin-scoped CRM picker is the only contact source.
        const safe = search.replace(/[^\p{L}\p{N} +@_-]/gu, '').slice(0, 70)
        const response = await fetch('/api/contacts-lite?limit=50&q=' +
          encodeURIComponent(safe), { cache: 'no-store', signal: ctrl.signal })
        const payload = await parseOpenWAApiResponse<{ contacts: Array<{ id: string; name: string | null; phone: string }> }>(response)
        if (!response.ok) throw new Error('فشل البحث في جهات الاتصال')
        if (!ctrl.signal.aborted) {
          setContactResults(payload.contacts ?? [])
          setContactError(null)
        }
      } catch {
        if (!ctrl.signal.aborted) {
          setContactResults([])
          setContactError('تعذّر تحميل جهات الاتصال من CRM.')
        }
      }
    }, 300)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [search])

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/trusted-admins', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) return
        const data = await response.json() as { identities?: typeof trustedAdmins }
        if (!controller.signal.aborted) setTrustedAdmins((data.identities ?? []).filter(identity =>
          identity.status === 'active' && identity.allowed_capabilities?.includes('change_requests.approve')))
      }).catch(() => {})
    return () => controller.abort()
  // Initial read only; Pilot opt-in never mutates identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function approveAdminAlert(identityId: string) {
    if (busy || verifying || !adminAlertConsent) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(endpoint, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'grant_admin_alert', identity_id: identityId,
          consent_confirmed: true, confirm_admin_alerts: true,
          ack_duplicate_sessions: duplicateAck,
        }),
      })
      const data = await parseOpenWAApiResponse<PilotState>(response)
      if (!response.ok) throw new Error(data.error || 'تعذّر اعتماد إشعارات الإدارة')
      setAdminAlertConsent(false)
      setNotice('تم اعتماد الرقم الإداري الموثق لإشعارات الموافقة (api) على هذه الجلسة لمدة أربع ساعات، دون إرسال تلقائي للطلبات السابقة. يمكنك إعادة إشعار CHG المعلق من قسم طلبات التغيير.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر اعتماد إشعارات الإدارة')
    } finally { setBusy(false) }
  }

  function addRecipient(raw: string) {
    const normalized = normalizeTestRecipient(raw)
    if (!normalized || selectedRecipients.includes(normalized) || selectedRecipients.length >= 10) return
    setSelectedRecipients(current => [...current, normalized])
    setRecipient('')
  }

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
        pilot_agent_hourly_cap: data.guardrails.pilot_agent_hourly_cap ?? data.guardrails.hourly_cap,
        pilot_agent_daily_cap: data.guardrails.pilot_agent_daily_cap ?? data.guardrails.daily_cap,
        pilot_manual_hourly_cap: data.guardrails.pilot_manual_hourly_cap ?? data.guardrails.hourly_cap,
        pilot_manual_daily_cap: data.guardrails.pilot_manual_daily_cap ?? data.guardrails.daily_cap,
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

  async function submit(action: PilotAction, workload?: 'manual' | 'agent') {
    if (busy || verifying) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = { action }
      if (action === 'prepare') body.confirm_prepare = true
      if (action === 'limits') Object.assign(body, limits)
      if (action === 'grant_batch') Object.assign(body, {
        workload, recipients: selectedRecipients, messages_per_recipient: messagesPerRecipient,
        consent_confirmed: consent,
        consent_basis: workload === 'agent' && phoneCallConsent ? 'phone_call' : 'verified_inbound',
        phone_call_opt_in_confirmed: workload === 'agent' && phoneCallConsent,
        ack_duplicate_sessions: duplicateAck, hours: 4,
        confirm_agent_task_test: workload === 'agent',
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
      if (action === 'grant_batch') { setSelectedRecipients([]); setRecipient(''); setConsent(false); setPhoneCallConsent(false) }
      if (['stop', 'disable', 'enable'].includes(action)) { setVerified(false); setDuplicateAck(false); setVerifiedStatus(null) }
      if (action === 'stop' || action === 'disable' || action === 'enable') onPilotChange?.()
      setNotice(action === 'grant_batch'
        ? `تم اعتماد ${selectedRecipients.length} أرقام فقط لنوع ${workload} لمدة أربع ساعات دون إرسال.`
        : w(action === 'prepare' ? 'devPilotPrepared'
          : action === 'disable' ? 'devPilotDisabled' : action === 'enable' ? 'devPilotEnabled'
          : action === 'stop' ? 'devPilotStopped'
          : action === 'activate' ? 'devPilotStarted' : 'devPilotLimitsSaved'))
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
    : state.active_admissions <= 10 ? 'start'
    : 'multiple'
  const running = busy || verifying
  const selectedCount = selectedRecipients.length
  const requiredMessages = selectedCount * messagesPerRecipient
  const feasibleCapacity = Number.isInteger(messagesPerRecipient) &&
    messagesPerRecipient >= 1 &&
    messagesPerRecipient <= OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT &&
    requiredMessages <= OPENWA_TEST_PILOT_MAX_HOURLY
  const agentMissingCaps = state && selectedCount > 0
    ? missingPilotCohortCaps(state.guardrails, selectedCount, 'agent', messagesPerRecipient) : []
  const manualMissingCaps = state && selectedCount > 0
    ? missingPilotCohortCaps(state.guardrails, selectedCount, 'manual', messagesPerRecipient) : []
  function recommendCaps(workload: PilotCohortWorkload) {
    if (!state || !state.paused || state.active_admissions > 0 || selectedRecipients.length < 1) return
    if (!feasibleCapacity) return
    const suggested = suggestedPilotCohortCaps(state.guardrails, selectedRecipients.length, workload, messagesPerRecipient)
    setLimits(previous => ({ ...previous, ...suggested }))
    setAdvancedOpen(true)
    setNotice(`تمت تعبئة الحدود اللازمة لـ ${selectedRecipients.length} جهات × ${messagesPerRecipient} رسائل = ${requiredMessages} رسالة، دون حفظها. راجع الإعدادات المتقدمة واضغط «حفظ الحدود» قبل الاعتماد.`)
    setError(null)
  }
  const needsDuplicateReview = (state?.same_identity_ready_connections ?? 0) > 1
  const canApprove = Boolean(state?.configured && state.enforced && state.paused &&
    selectedCount > 0 && selectedCount <= 10 && feasibleCapacity &&
    consent && verified && state.unsettled_outbound === 0 && (!needsDuplicateReview || duplicateAck))
  const canStart = Boolean(state?.configured && state.enforced && state.paused && verified
    && state.active_admissions > 0 && state.active_admissions <= 10 && state.unsettled_outbound === 0
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
      {state?.pilot_enabled && state.last_denial && <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>آخر رفض إرسال بواسطة Pilot لهذه الجلسة</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{state.last_denial.reason === 'not_allowlisted'
            ? 'المستلم الفعلي غير موجود ضمن موافقات هذه الجلسة لنوع الإرسال المحدد؛ تفعيل Pilot واعتماد جهات أخرى لا يمنح هذه المحادثة تصريحًا.'
            : state.last_denial.reason === 'connection_scope_mismatch'
              ? 'الجلسة لم تطابق شروط الجاهزية والحساب وقت محاولة الإرسال.'
              : state.last_denial.reason === 'invalid_identity'
                ? 'هوية المستلم الأصلية لم تكن قابلة للتحقق.'
                : 'لم تنجح محاولة الإرسال في اجتياز شرط الاعتماد.'}</p>
          <p className="text-xs">النوع: {state.last_denial.workload === 'agent' ? 'ردود الوكلاء ومهامهم' : state.last_denial.workload === 'manual' ? 'الرسائل اليدوية' : state.last_denial.workload} · الوقت: {new Date(state.last_denial.created_at).toLocaleString('ar')}</p>
          {state.last_denial.reason === 'not_allowlisted' && <p>
            للتصحيح: راجع المحادثة والجهة المقصودة على هذه الجلسة؛ قد تكون الهوية الأصلية @lid مختلفة عن اعتماد الرقم @c.us.
            أوقف Pilot أولًا (سيُلغي جميع الموافقات السابقة)، ثم أعد اعتماد الجهات المقصودة بعد التحقق من الموافقة على واتساب،
            وأعد التفعيل. الرسالة التي رُفضت لم تصل إلى المزود ولن يُعاد إرسالها تلقائيًا؛ يلزم حدث/رسالة جديدة بعد التصحيح.
          </p>}
        </AlertDescription>
      </Alert>}

      {state && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{w('devPilotModeTitle')}</p>
          <p className="text-xs text-muted-foreground">{w(state.pilot_enabled ? 'devPilotModeEnabledHint' : 'devPilotModeDisabledHint')}</p>
           <p className="text-xs text-amber-700 dark:text-amber-400">تنبيه: تبديل وضع Pilot يعيد حدود الاختبار المحافظة (3 رسائل/ساعة و10/يوم عند التفعيل) ويلغي اعتمادات الأرقام السابقة. إن كنت قد حفظت 100/1000، فستحتاج إلى إعادة حفظها صراحةً وإعادة اعتماد الجهات بعد إيقاف التجربة.</p>
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
            [w('devPilotStepApprove'), state.active_admissions > 0 || step === 'active'],
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
          <p className="font-semibold">اعتماد عدة أرقام لهذه الجلسة على TEST</p>
          <p className="text-xs text-muted-foreground">
            ابحث في جهات اتصال CRM وأضف ما يصل إلى 10 أرقام، أو أدخل رقمًا جديدًا.
            لا يشترط وجود رقم في CRM لاعتماد Pilot، لكن إنشاء مهمة Coverage
            يسجّل الأرقام الجديدة في CRM داخليًا. لمهام الوكلاء يمكنك اعتماد
            موافقة واتساب الصريحة التي حصلت عليها عبر مكالمة هاتفية، دون رسالة واردة.
          </p>
          <Input value={search} disabled={running}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو الرقم من جهات اتصال CRM" />
          {contactError ? <p role="alert" className="text-xs text-destructive">{contactError}</p> : null}
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {contactResults.filter(item => normalizeTestRecipient(item.phone) &&
                !selectedRecipients.includes(normalizeTestRecipient(item.phone)!)).map(contact => (
              <Button key={contact.id} type="button" variant="outline" size="sm"
                className="w-full justify-start" disabled={running || selectedRecipients.length >= 10}
                onClick={() => addRecipient(contact.phone)}>
                + {contact.name?.trim() || 'بدون اسم'} · {contact.phone}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-44 flex-1">
              <Input id={`pilot-recipient-${connectionId}`} value={recipient} autoComplete="off"
                dir="ltr" placeholder="+9677XXXXXXXX" disabled={running}
                onChange={e => setRecipient(e.target.value)} />
            </div>
            <Button type="button" variant="outline" disabled={running || !normalizedRecipient ||
              selectedRecipients.includes(normalizedRecipient) || selectedRecipients.length >= 10}
              onClick={() => addRecipient(recipient)}>إضافة الرقم</Button>
          </div>
          {recipient.trim() && !normalizedRecipient &&
            <p className="text-xs text-destructive">أدخل رقمًا دوليًا صحيحًا أو معرف OpenWA موثقًا.</p>}
          <div className="space-y-1" aria-label="أرقام اختبار OpenWA المختارة">
            {selectedRecipients.map((value,index) => <div key={value}
              className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
              <span dir="ltr">{index + 1}. {value}</span>
              <Button type="button" variant="ghost" size="sm" disabled={running}
                onClick={() => setSelectedRecipients(old => old.filter(item => item !== value))}>إزالة</Button>
            </div>)}
            <p className="text-xs">المختارة: {selectedCount} من 10</p>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor={`pilot-per-recipient-${connectionId}`}>عدد الرسائل المطلوب استيعابها لكل جهة</Label>
            <Input id={`pilot-per-recipient-${connectionId}`} type="number" min={1}
              max={OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT} step={1}
              value={messagesPerRecipient} disabled={running}
              onChange={e => setMessagesPerRecipient(Number(e.target.value))} />
            <p className="text-xs text-muted-foreground">
              الحساب: {selectedCount} جهات × {Number.isFinite(messagesPerRecipient) ? messagesPerRecipient : 0} رسائل =
              {' '}{requiredMessages} رسالة. هذا حد سعة مشترك للجلسة ولنوع الإرسال، وليس إرسالًا تلقائيًا أو ضمانًا لكل جهة.
              حد أول تواصل يقاس بعدد الجهات الجديدة فقط ({selectedCount}).
            </p>
            {selectedCount > 0 && !feasibleCapacity &&
              <p role="alert" className="text-xs text-destructive">
                الحد الساعي الأقصى 100 رسالة. اختر عددًا من 1 إلى {Math.floor(OPENWA_TEST_PILOT_MAX_HOURLY / selectedCount)} رسالة لكل جهة، أو قلّل الجهات.
              </p>}
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id={`pilot-consent-${connectionId}`} checked={consent} disabled={running}
              onCheckedChange={v => setConsent(v === true)} />
            <Label htmlFor={`pilot-consent-${connectionId}`} className="text-sm leading-relaxed">
              أؤكد موافقة كل جهة محددة على التواصل والتقيد بحدود TEST.
            </Label>
          </div>
          <div className="flex items-start gap-2 rounded-md border p-3">
            <Checkbox id={`pilot-call-consent-${connectionId}`} checked={phoneCallConsent} disabled={running}
              onCheckedChange={v => setPhoneCallConsent(v === true)} />
            <Label htmlFor={`pilot-call-consent-${connectionId}`} className="text-sm leading-relaxed">
              حصلتُ على موافقة صريحة من كل رقم عبر مكالمة هاتفية لتلقي رسائل واتساب المتعلقة بهذه المهمة.
              سجّل هذه الموافقة بوصفها أساس الاعتماد بدل اشتراط محادثة واردة خلال 24 ساعة.
            </Label>
          </div>
          {needsDuplicateReview && !duplicateAck &&
            <p className="text-xs text-amber-600">{w('devPilotMustReviewDuplicates')}</p>}
          {selectedRecipients.length > 0 && (agentMissingCaps.length > 0 || manualMissingCaps.length > 0) &&
            <div role="status" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium">السعة المحفوظة لا تستوعب {selectedCount} جهات × {messagesPerRecipient} رسائل = {requiredMessages} رسالة (وأول تواصل لـ {selectedCount} جهات).</p>
              {agentMissingCaps.length > 0 && <p className="text-xs">قيود مهام الوكيل: {agentMissingCaps.map(key => capName[key] ?? key).join('، ')}.</p>}
              {manualMissingCaps.length > 0 && <p className="text-xs">قيود الرسائل العادية: {manualMissingCaps.map(key => capName[key] ?? key).join('، ')}.</p>}
              <div className="flex flex-wrap gap-2">
                {agentMissingCaps.length > 0 && <Button type="button" size="sm" variant="outline" disabled={running || !feasibleCapacity}
                  onClick={() => recommendCaps('agent')}>تجهيز حدود الوكيل لـ {selectedRecipients.length} أرقام</Button>}
                {manualMissingCaps.length > 0 && <Button type="button" size="sm" variant="outline" disabled={running || !feasibleCapacity}
                  onClick={() => recommendCaps('manual')}>تجهيز الحدود العادية لـ {selectedRecipients.length} أرقام</Button>}
              </div>
              <p className="text-xs text-muted-foreground">سيتم تعبئة الإعدادات المتقدمة فقط. يجب مراجعتها وحفظها قبل الاعتماد، ولن يبدأ الإرسال أو تتغيّر الحدود تلقائيًا.</p>
            </div>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={running || !canApprove || manualMissingCaps.length > 0}
              onClick={() => void submit('grant_batch','manual')}>
              اعتماد الأرقام للرسائل العادية
            </Button>
            <Button variant="outline" disabled={running || !canApprove || agentMissingCaps.length > 0}
              onClick={() => {
                if (window.confirm(phoneCallConsent
                  ? 'اعتماد أرقام الوكلاء وفق الموافقة الهاتفية التي أكّدت توثيقها؟ لا يشترط وصول رسالة واردة، وقد يبدأ الإرسال بعد تشغيل Pilot.'
                  : 'اعتماد هذه الأرقام بمسار المحادثة الواردة الحديثة؟ سيظل التحقق من نافذة 24 ساعة مطلوبًا لهذا المسار.'))
                  void submit('grant_batch','agent')
              }}>
              اعتماد الأرقام لمهام الوكلاء
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            اضبط الحد الساعي واليومي والإحماء حسب عدد الجهات × الرسائل لكل جهة، وحد أول تواصل حسب عدد الجهات فقط. تبقى الحدود العامة وإيقاف الجلسة وسلامة OpenWA سارية.
          </p>
        </section>}

        {step === 'start' && <section className="space-y-3 rounded-lg border p-4">
          <p className="font-semibold">{w('devPilotReadyToStart')}</p>
          <p className="text-sm">نوع السماح: {state.approved_workload === 'agent' ? 'مهام الوكلاء (agent)' : 'الرسائل اليدوية (manual)'} · عدد الأرقام: {state.active_admissions}</p>
          <p className="text-sm text-muted-foreground">{w('devPilotStartDescription')}</p>
          {needsDuplicateReview && !duplicateAck &&
            <p className="text-xs text-amber-600 dark:text-amber-400">{w('devPilotMustReviewDuplicates')}</p>}
          <Button disabled={running || !canStart} onClick={() => void submit('activate')}>
            <Play className="me-2 size-4" />{w('devPilotActivate')}
          </Button>
        </section>}

        {step === 'active' && <section className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-5" />{w('devPilotNowActive')}</p>
          <p className="text-sm text-muted-foreground">اعتمدت الجلسة {state.active_admissions} أرقام لنوع {state.approved_workload}؛ سعة الاعتماد المخططة {state.approved_messages_per_recipient ?? 1} رسائل لكل جهة ({state.required_cohort_messages ?? state.active_admissions} رسالة). الإرسال محدود بالضوابط المحفوظة ويتوقف تلقائيًا عند تجاوزها.</p>
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-semibold">إشعارات طلبات اعتماد الإدارة عبر OpenWA (api)</p>
            <p className="text-xs text-muted-foreground">هذا النوع منفصل عن رسائل الوكلاء؛ لا يمنح اعتماد agent إذنًا تلقائيًا لإرسال رمز الموافقة إلى المسؤول. يؤكد المسؤول موافقته على تلقي هذه الإشعارات عبر الجلسة الحالية.</p>
            <div className="flex items-start gap-2">
              <Checkbox id={`pilot-admin-alert-consent-${connectionId}`} checked={adminAlertConsent}
                disabled={running} onCheckedChange={value => setAdminAlertConsent(value === true)} />
              <Label htmlFor={`pilot-admin-alert-consent-${connectionId}`} className="text-xs leading-relaxed">
                أؤكد موافقة المسؤول الموثق على استقبال إشعارات الموافقة على واتساب من هذه الجلسة.
              </Label>
            </div>
            {trustedAdmins.map(identity =>
              <Button key={identity.id} type="button" variant="outline" size="sm"
                disabled={running || !adminAlertConsent || (needsDuplicateReview && !duplicateAck)}
                onClick={() => void approveAdminAlert(identity.id)}>
                اعتماد {identity.display_name || `المسؤول ••••${identity.normalized_address.slice(-4)}`} لإشعارات الإدارة
              </Button>)}
            {!trustedAdmins.length && <p className="text-xs text-muted-foreground">لا توجد هوية إدارة موثقة لديها صلاحية الاعتماد في هذا الحساب.</p>}
          </div>
          <p className="text-xs text-muted-foreground">الحدود الفعلية الآن: {state.guardrails.hourly_cap} رسالة/ساعة و{state.guardrails.daily_cap} رسالة/يوم؛ حد الوكيل {state.guardrails.pilot_agent_hourly_cap ?? state.guardrails.hourly_cap}/ساعة و{state.guardrails.pilot_agent_daily_cap ?? state.guardrails.daily_cap}/يوم. تغييرها لا يحدث تلقائيًا من حساب الحد الأدنى.</p>
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

        {state.pilot_enabled && state.configured && <details className="rounded-lg border px-4 py-3"
          open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium">
            <span className="flex items-center gap-2"><SlidersHorizontal className="size-4" />{w('devPilotAdvanced')}</span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">{w('devPilotLimitsHelp')}</p>
          <p className="mt-2 text-xs font-medium">القيم المحفوظة للجلسة: {state.guardrails.hourly_cap} رسالة/ساعة، {state.guardrails.daily_cap} رسالة/يوم؛ الوكيل: {state.guardrails.pilot_agent_hourly_cap ?? state.guardrails.hourly_cap}/ساعة، {state.guardrails.pilot_agent_daily_cap ?? state.guardrails.daily_cap}/يوم. تحديث البيانات متاح أسفل القسم.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {([
              ['hourly_cap', 'devPilotHourly', 1, OPENWA_TEST_PILOT_MAX_HOURLY],
              ['daily_cap', 'devPilotDaily', 1, OPENWA_TEST_PILOT_MAX_DAILY],
              ['first_touch_daily_cap', 'devPilotFirstTouch', 0, OPENWA_TEST_PILOT_MAX_FIRST_TOUCH],
              ['minimum_interval_ms', 'devPilotInterval', OPENWA_TEST_PILOT_MIN_INTERVAL_MS, 600000],
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
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {([
              ['pilot_agent_hourly_cap','الوكيل — الحد الساعي',OPENWA_TEST_PILOT_MAX_HOURLY],
              ['pilot_agent_daily_cap','الوكيل — الحد اليومي',OPENWA_TEST_PILOT_MAX_DAILY],
              ['pilot_manual_hourly_cap','العادي — الحد الساعي',OPENWA_TEST_PILOT_MAX_HOURLY],
              ['pilot_manual_daily_cap','العادي — الحد اليومي',OPENWA_TEST_PILOT_MAX_DAILY],
            ] as const).map(([key,label,max]) => (
              <label key={key} className="space-y-1 text-sm">
                <span>{label}</span>
                <Input type="number" min={1} max={max} value={limits[key]}
                  disabled={running || !state.paused || state.active_admissions > 0}
                  onChange={e => setLimits(current => ({ ...current, [key]: Number(e.target.value) }))} />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            السقف القابل للضبط في TEST هو 100 رسالة/ساعة و1000 رسالة/يوم للجلسة، وتُقيَّد رسائل الوكيل والرسائل العادية بالحد المشترك. يبقى سقف أول تواصل 10 أرقام جديدة/يوم والتباعد 15 ثانية على الأقل؛ لا تعني سعة 1000 رسالة موافقةً على مراسلة 1000 عميل جديد. يجب إيقاف الجلسة وحفظ الحدود بموافقة المسؤول قبل التفعيل.
          </p>
          <Button className="mt-3" size="sm" variant="outline" disabled={running || !state.paused || state.active_admissions > 0}
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
