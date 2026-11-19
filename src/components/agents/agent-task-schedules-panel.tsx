'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Clock3, PauseCircle, PlayCircle, RefreshCw, ShieldCheck, Eye, Plus, AlertTriangle, Pencil, Ban, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Firing = {
  id: string; status: string; attempts: number; createdAt: string
  scheduledFor: string | null; availableAt: string; taskId: string | null
  skipReason: string | null; reason: string | null; taskStatus?: string | null
}
type Rule = {
  id: string; taskType: string; version: number; agentId: string
  triggerKind: 'schedule' | 'business_event'; status: string
  scheduleKind: 'once' | 'recurring' | null; nextFireAt: string | null
  intervalMinutes: number | null; eventType: string | null; subjectId: string | null
  policyVersion: number; overlapPolicy: 'skip' | 'defer'
  approvedRevisionId: string | null; skippedOccurrences: number
  createdAt: string; editedAt: string | null; cancelledAt: string | null; firings: Firing[]
}
type Catalog = {
  rules: Rule[]
  agents: Array<{ id: string; name: string; publishedRevisionId: string | null }>
  coverageRequests: Array<{ id: string; status: string }>
  services: Array<{ id: string; name: string; status: string }>
  connections: Array<{ id: string; name: string; provider: 'meta_cloud'|'openwa'; ready: boolean }>
  contacts: Array<{ id: string; name: string }>
  maxPendingPerAccount: number
  taskWorkerEnabled: boolean
  enableAllowedInTest: boolean
  schedulerTestGateConfigured: boolean
  testProjectVerified: boolean
}
type Preview = { mode: string; nextFireAt: string | null; intervalMinutes: number | null; notice: string }
type ScheduleHealth = {
  enabledSchedules: number
  pending: number; claimed: number; failed: number; dead: number
  skippedFirings: number; skippedOccurrences: number
  backlog: number; backlogCap: number; staleClaims: number
  dueLagSeconds: number; backlogLagSeconds: number
  oldestDueAt: string | null; oldestAvailableAt: string | null
  taskWorkerEnabled: boolean
  runnerLastSucceededAt: string | null; runnerLastStartedAt: string | null
  runnerLastResult: 'success' | 'failed' | null; runnerConsecutiveFailures: number
  runnerTickCount: number; observedAt: string
}
type HealthResponse = { health: ScheduleHealth; alerts: string[] }
const healthAlertNames: Record<string, string> = {
  STALE_CLAIMS: 'حجوزات تجاوزت مهلة العامل',
  DEAD_FIRINGS: 'تشغيلات توقفت بعد استنفاد المحاولات',
  BACKLOG_NEAR_CAP: 'اقتربت قائمة الانتظار من حد الحساب',
  SCHEDULER_LAG: 'تأخر تنفيذ الجدولة عن الاستحقاق',
  WORKER_ERRORS: 'فشل سابق في تشغيل العامل',
  WORKER_HEARTBEAT_STALE: 'توقف أو تأخر تسجيل نبضات العامل أكثر من 3 دقائق',
  WORKER_HEARTBEAT_DELAYED: 'تأخرت نبضات العامل أو توجد إخفاقات متتالية',
  WORKER_HEARTBEAT_UNVERIFIED: 'تعذّر إثبات نبضات العامل الحالية',
}
type PromotionPreview = {
  previewOnly: boolean; readyForApproval: boolean; fingerprint: string; reviewedAt: string
  connection: { id: string; name: string; provider: string }
  audience: { total: number; contacts: Array<{ id: string; name: string | null; phone: string | null }> }
  blockers: string[]
}

async function json<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('تعذّر قراءة استجابة الخادم. تأكد من تشغيل نسخة WACRM الحالية.')
  }
  if (!response.ok) {
    const record = data as Record<string, unknown>
    throw new Error(typeof record.error === 'string' ? record.error : 'فشلت العملية (' + response.status + ').')
  }
  return data as T
}

function localDateTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function displayTime(value: string | null, locale = 'ar'): string {
  if (!value) return '—'
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}
function statusName(status: string) {
  return ({
    enabled: 'نشطة', paused: 'موقوفة', completed: 'انتهى توليد الجدولة',
    pending: 'بانتظار الحجز', claimed: 'محجوزة', failed: 'إعادة المحاولة',
    dead: 'توقفت بعد المحاولات', skipped: 'تم تجاوز التداخل', cancelled: 'ملغاة نهائيًا',
  } as Record<string, string>)[status] ?? status
}
function nextSubmission(): string {
  return crypto.randomUUID()
}

/** A strictly no-send admin editor. Create only PAUSED policies; start is separately
 * operator-confirmed and additionally server-gated in TEST.
 */
export function AgentTaskSchedulesPanel({ onOpenTasks }: { onOpenTasks?: () => void } = {}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthUnavailable, setHealthUnavailable] = useState(false)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [timezone, setTimezone] = useState('UTC')
  const [agentId, setAgentId] = useState('')
  const [taskType, setTaskType] = useState<'coverage.sourcing' | 'services.promotion'>('coverage.sourcing')
  const [version, setVersion] = useState<1 | 2>(2)
  const [sourceId, setSourceId] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [promotionReview, setPromotionReview] = useState<PromotionPreview | null>(null)
  const [consentAcknowledged, setConsentAcknowledged] = useState(false)
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false)
  const [recurringAcknowledged, setRecurringAcknowledged] = useState(false)
  const [triggerKind, setTriggerKind] = useState<'schedule' | 'business_event'>('schedule')
  const [scheduleKind, setScheduleKind] = useState<'once' | 'recurring'>('once')
  const [eventType, setEventType] = useState('coverage.request.activated')
  const [nextLocal, setNextLocal] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [overlapPolicy, setOverlapPolicy] = useState<'skip' | 'defer'>('skip')
  const [submissionId, setSubmissionId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<'once' | 'recurring'>('once')
  const [editLocalTime, setEditLocalTime] = useState('')
  const [editInterval, setEditInterval] = useState(60)
  const [editOverlap, setEditOverlap] = useState<'skip' | 'defer'>('skip')

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    setNextLocal(localDateTime(new Date(Date.now() + 10 * 60_000)))
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      const data = await json<HealthResponse>(await fetch(
        '/api/agent-tasks/triggers/health', { cache: 'no-store' }))
      setHealth(data)
      setHealthUnavailable(false)
    } catch {
      // Health failure must never hide or clear the editable schedule list.
      setHealth(null)
      setHealthUnavailable(true)
    }
  }, [])

  const reload = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      const data = await json<Catalog>(await fetch('/api/agent-tasks/triggers', { cache: 'no-store' }))
      setCatalog(data)
      await refreshHealth()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تحميل قواعد الجدولة.')
    } finally {
      setBusy(null)
    }
  }, [refreshHealth])

  useEffect(() => { void reload() }, [reload])
  // Read-only telemetry refresh. Never triggers worker execution.
  useEffect(() => {
    const timer = setInterval(() => { void refreshHealth() }, 60_000)
    return () => clearInterval(timer)
  }, [refreshHealth])

  const subjectOptions = useMemo(() =>
    taskType === 'coverage.sourcing'
      ? (catalog?.coverageRequests ?? []).map(r => ({ id: r.id, label: r.id.slice(0, 8) + ' · ' + r.status }))
      : (catalog?.services ?? []).map(s => ({ id: s.id, label: s.name })),
    [catalog, taskType])

  const draft = useCallback((id: string) => ({
    agentId, submissionId: id, taskType, taskTypeVersion: version, triggerKind,
    scheduleKind: triggerKind === 'schedule' ? scheduleKind : null,
    nextFireAt: triggerKind === 'schedule' && nextLocal
      ? new Date(nextLocal).toISOString() : null,
    intervalMinutes: triggerKind === 'schedule' && scheduleKind === 'recurring'
      ? intervalMinutes : null,
    eventType: triggerKind === 'business_event' ? eventType : null,
    coverageRequestId: taskType === 'coverage.sourcing' ? sourceId : null,
    serviceId: taskType === 'services.promotion' ? sourceId : null,
    whatsappConnectionId: taskType === 'coverage.sourcing' ? connectionId : null,
    selectedContactIds: taskType === 'coverage.sourcing' ? selectedContactIds : [],
    connectionId: taskType === 'services.promotion' ? connectionId : null,
    promotionReview: taskType === 'services.promotion' && promotionReview
      ? {
        fingerprint: promotionReview.fingerprint,
        reviewedAt: promotionReview.reviewedAt,
        consentAcknowledged,
        approvalAcknowledged,
        recurringAcknowledged: scheduleKind === 'recurring' && recurringAcknowledged,
      } : null,
    overlapPolicy,
  }), [agentId, submissionId, taskType, version, triggerKind, scheduleKind, nextLocal,
    intervalMinutes, eventType, sourceId, connectionId, selectedContactIds,
    promotionReview, consentAcknowledged, approvalAcknowledged,
    recurringAcknowledged, overlapPolicy])

  const inspect = async () => {
    setBusy('preview')
    setError(null)
    setPreview(null)
    try {
      if (taskType === 'services.promotion') {
        const params = new URLSearchParams({ serviceId: sourceId, agentId, connectionId })
        const review = await json<PromotionPreview>(await fetch(
          '/api/agent-tasks/promotion/preview?' + params.toString(), { cache: 'no-store' }))
        setPromotionReview(review)
        setPreview({
          mode: 'schedule', nextFireAt: nextLocal ? new Date(nextLocal).toISOString() : null,
          intervalMinutes: scheduleKind === 'recurring' ? intervalMinutes : null,
          notice: review.readyForApproval
            ? 'الجمهور جاهز للمراجعة. راجع القائمة وأقر بالموافقة؛ لن يتم إرسال أي رسالة عند الحفظ.'
            : 'المعاينة لا تسمح بالحفظ بسبب ضوابط الحملة. أزل العوائق ثم أعد المعاينة.',
        })
      } else {
        const result = await json<Preview>(await fetch('/api/agent-tasks/triggers/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft(submissionId || nextSubmission())),
        }))
        setPreview(result)
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذّرت المعاينة.') }
    finally { setBusy(null) }
  }

  const save = async () => {
    setBusy('create')
    setError(null)
    setSuccess(null)
    const id = submissionId || nextSubmission()
    setSubmissionId(id)
    try {
      const result = await json<{ id: string; status: string }>(
        await fetch('/api/agent-tasks/triggers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft(id)),
        }))
      setSuccess('حُفظت قاعدة الجدولة ' + result.id.slice(0, 8) + ' بحالة إيقاف. لم تُرسل رسائل.')
      setSubmissionId('')
      setPreview(null)
      setPromotionReview(null)
      setConsentAcknowledged(false)
      setApprovalAcknowledged(false)
      setRecurringAcknowledged(false)
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذّر حفظ الجدولة.') }
    finally { setBusy(null) }
  }

  const beginEdit = (rule: Rule) => {
    if (rule.status !== 'paused') return
    setEditingId(rule.id)
    setEditKind(rule.scheduleKind ?? 'once')
    setEditLocalTime(rule.nextFireAt ? localDateTime(new Date(rule.nextFireAt)) : '')
    setEditInterval(rule.intervalMinutes ?? 60)
    setEditOverlap(rule.overlapPolicy)
    setError(null)
    setSuccess(null)
  }

  const saveEdit = async (rule: Rule) => {
    setBusy('edit:' + rule.id)
    setError(null)
    setSuccess(null)
    try {
      const nextFireAt = rule.triggerKind === 'schedule' && editLocalTime
        ? new Date(editLocalTime).toISOString() : null
      const result = await json<{ policyVersion: number; skippedFirings: number }>(
        await fetch('/api/agent-tasks/triggers/' + rule.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'edit', expectedPolicyVersion: rule.policyVersion,
            scheduleKind: rule.triggerKind === 'schedule' ? editKind : null,
            nextFireAt,
            intervalMinutes: rule.triggerKind === 'schedule' && editKind === 'recurring'
              ? editInterval : null,
            overlapPolicy: editOverlap,
          }),
        }))
      setEditingId(null)
      setSuccess('حُفظت سياسة V' + result.policyVersion + ' وهي موقوفة. تم تجاوز ' +
        result.skippedFirings + ' من الحجوزات القديمة دون إلغاء المهام المنشأة.')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تعديل سياسة الجدولة.')
    } finally { setBusy(null) }
  }

  const cancelRule = async (rule: Rule) => {
    if (!window.confirm('إلغاء سياسة الجدولة نهائيًا؟ لن تنشأ حجوزات جديدة. لا تُلغى المهام التي بدأت أو الرسائل المرسلة بالفعل، ويجب إدارتها من قسم المهام.')) return
    setBusy('cancel:' + rule.id)
    setError(null)
    setSuccess(null)
    try {
      const result = await json<{ skippedFirings: number; linkedTasksUntouched: number }>(
        await fetch('/api/agent-tasks/triggers/' + rule.id, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedPolicyVersion: rule.policyVersion,
            confirmCancel: true,
          }),
        }))
      if (editingId === rule.id) setEditingId(null)
      setSuccess('أُلغيت السياسة نهائيًا. أوقفت ' + result.skippedFirings +
        ' من الحجوزات المعلقة؛ المهام المنشأة باقية ويجب متابعتها بشكل مستقل.')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر إلغاء السياسة.')
    } finally { setBusy(null) }
  }

  const changeStatus = async (rule: Rule, status: 'paused' | 'enabled') => {
    if (status === 'enabled' && !window.confirm(
      'هل تريد تمكين الجدولة على بيئة TEST المعتمدة؟ قد ينشئ تشغيل العامل مهامًا حقيقية عند الاستحقاق.'
    )) return
    setBusy(rule.id)
    setError(null)
    setSuccess(null)
    try {
      await json<{ status: string }>(await fetch(
        '/api/agent-tasks/triggers/' + rule.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, confirmEnable: status === 'enabled' }),
        }))
      setSuccess(status === 'paused' ? 'أُوقفت الجدولة. العمليات الجارية تحتاج متابعة مستقلة.' : 'تم تمكين الجدولة على TEST بعد التحقق.')
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذّر تعديل حالة الجدولة.') }
    finally { setBusy(null) }
  }

  const selectedConnection = catalog?.connections?.find(c => c.id === connectionId)
  const promoReady = taskType !== 'services.promotion' ||
    (promotionReview?.readyForApproval === true &&
      promotionReview.connection.id === connectionId &&
      consentAcknowledged && approvalAcknowledged &&
      (scheduleKind !== 'recurring' || recurringAcknowledged))
  const coverageReady = taskType !== 'coverage.sourcing' || version !== 2 ||
    (selectedConnection?.ready === true && selectedContactIds.length > 0)

  const selectClass = 'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/50'
  const labelClass = 'mb-1.5 block text-xs font-semibold text-muted-foreground'

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold"><CalendarClock className="h-5 w-5 text-primary" /> جدولة مهام الوكلاء</h2>
          <p className="text-sm leading-6 text-muted-foreground">قواعد مرة واحدة أو فواصل ثابتة وأحداث Coverage المعتمدة. إنشاء الجدولة لا يرسل واتساب ولا يفعّل العمل تلقائيًا.</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reload()}>
          <RefreshCw className="me-2 h-4 w-4" /> تحديث
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">القواعد المعروضة</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{catalog?.rules.length ?? '—'}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">حد Backlog لكل حساب</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{catalog?.maxPendingPerAccount ?? '—'}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">عامل المهام</p>
          <p className="mt-2 text-sm font-medium">{catalog?.taskWorkerEnabled ? 'مسموح من إعدادات الحساب' : 'موقوف على الحساب'}</p>
          <p className="mt-1 text-xs text-muted-foreground">السماح ليس دليلًا على أن رسالة وصلت</p>
        </div>
      </div>

      <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label="مراقبة جدولة المهام">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">صحة الجدولة والتعافي</h3>
            <p className="mt-1 text-xs text-muted-foreground">مراقبة قراءة فقط، دون تشغيل عامل أو إرسال رسائل. الأرقام تخص حسابك؛ نبضة العامل تخص TEST.</p>
          </div>
          {health && <span className="text-xs text-muted-foreground">آخر فحص: {displayTime(health.health.observedAt)}</span>}
        </div>
        {healthUnavailable ? (
          <p role="status" className="text-sm text-muted-foreground">تعذّر تحميل مؤشرات الجدولة. لا يعني ذلك أن العامل توقف؛ راجع CI وMigration 192 وحاول التحديث.</p>
        ) : health ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Backlog من أصل الحد</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{health.health.backlog} / {health.health.backlogCap}</p>
                <p className="text-xs text-muted-foreground">بانتظار: {health.health.pending} · محجوزة: {health.health.claimed}</p>
              </div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">فشل / Dead</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{health.health.failed} / {health.health.dead}</p>
                <p className="text-xs text-muted-foreground">عقود منتهية: {health.health.staleClaims}</p>
              </div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">تأخير الجدولة / Backlog</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{health.health.dueLagSeconds}ث / {health.health.backlogLagSeconds}ث</p>
                <p className="text-xs text-muted-foreground">المواعيد حسب UTC وبفواصل زمنية ثابتة</p>
              </div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">آخر نجاح للعامل على TEST</p>
                <p className="mt-1 text-sm font-medium">{displayTime(health.health.runnerLastSucceededAt)}</p>
                <p className="text-xs text-muted-foreground">النبضات: {health.health.runnerTickCount} · إخفاقات متتابعة: {health.health.runnerConsecutiveFailures}</p>
              </div>
            </div>
            {health.alerts.length > 0 ? (
              <div role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs font-semibold">تنبيهات تشغيلية — لا تُعد دليلًا على فشل الإرسال</p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-xs">
                  {health.alerts.map(code =>
                    <li key={code}>{healthAlertNames[code] ?? code}</li>)}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">لا توجد تنبيهات ضمن حدود القياس الحالية. لا تعني هذه المؤشرات اجتياز الإرسال أو قبول TEST الحي.</p>
            )}
          </>
        ) : <p className="text-xs text-muted-foreground">جارٍ تحميل المؤشرات…</p>}
      </section>

      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {success && <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">{success}</p>}

      <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><Plus className="h-4 w-4" /> قاعدة جديدة</h3>
        <p className="mb-5 text-xs text-muted-foreground">التوقيت المعروض حسب {timezone}. التكرار بالدقائق المنقضية، وليس تقويمًا شهريًا أو توقيتًا صيفيًا.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="sch-agent">الوكيل المنشور</label>
            <select id="sch-agent" className={selectClass} value={agentId} onChange={e => { setAgentId(e.target.value); setPreview(null); setPromotionReview(null) }}>
              <option value="">اختر وكيلاً</option>
              {(catalog?.agents ?? []).map(a =>
                <option key={a.id} value={a.id} disabled={!a.publishedRevisionId}>
                  {a.name}{!a.publishedRevisionId ? ' · لا توجد نسخة منشورة' : ''}
                </option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="sch-tasktype">نوع المهمة</label>
            <select id="sch-tasktype" className={selectClass} value={taskType} onChange={e => {
              const value = e.target.value as typeof taskType
              setTaskType(value); setVersion(2)
              setTriggerKind('schedule'); setSourceId(''); setConnectionId('')
              setSelectedContactIds([]); setPromotionReview(null)
              setConsentAcknowledged(false); setApprovalAcknowledged(false)
              setPreview(null)
            }}>
              <option value="coverage.sourcing">البحث عن عروض تغطية</option>
              <option value="services.promotion">ترويج الخدمات (يخضع لبوابة Pilot)</option>
            </select>
          </div>
          {taskType === 'coverage.sourcing' && (
            <div>
              <label className={labelClass} htmlFor="sch-version">إصدار مهمة التغطية</label>
              <select id="sch-version" className={selectClass} value={version}
                onChange={e => setVersion(Number(e.target.value) as 1 | 2)}>
                <option value={2}>V2 — دورة المورد</option>
                <option value={1}>V1 — الأساس</option>
              </select>
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="sch-source">{taskType === 'coverage.sourcing' ? 'طلب التغطية' : 'الخدمة'}</label>
            <select id="sch-source" className={selectClass} value={sourceId} onChange={e => { setSourceId(e.target.value); setPreview(null); setPromotionReview(null) }}>
              <option value="">اختر المصدر ضمن الحساب</option>
              {subjectOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          {version === 2 && <div>
            <label className={labelClass} htmlFor="sch-connection">اتصال واتساب المعتمد</label>
            <select id="sch-connection" className={selectClass} value={connectionId}
              onChange={e => { setConnectionId(e.target.value); setPromotionReview(null);
                setSelectedContactIds([]); setPreview(null) }}>
              <option value="">اختر اتصالًا جاهزًا</option>
              {(catalog?.connections ?? []).map(c =>
                <option key={c.id} value={c.id} disabled={!c.ready}>
                  {c.name} · {c.provider === 'meta_cloud' ? 'Meta Cloud' : 'OpenWA'}
                  {!c.ready ? ' · غير جاهز' : ''}
                </option>)}
            </select>
          </div>}
          {taskType === 'coverage.sourcing' && version === 2 && <div className="sm:col-span-2">
            <p className={labelClass}>المستهدفون المعتمدون (إلزامي لجميع اتصالات Coverage V2، بحد 20 جهة اتصال)</p>
            <div className="max-h-36 overflow-y-auto rounded-lg border p-2 grid gap-2 sm:grid-cols-2">
              {(catalog?.contacts ?? []).map(contact =>
                <label key={contact.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={selectedContactIds.includes(contact.id)}
                    onChange={e => setSelectedContactIds(old => e.target.checked
                      ? old.includes(contact.id) || old.length >= 20 ? old : [...old, contact.id]
                      : old.filter(id => id !== contact.id))} />
                  <span>{contact.name}</span>
                </label>)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">المحدد: {selectedContactIds.length}. سيتم التحقق من أهلية كل جهة اتصال عند الاستحقاق.</p>
          </div>}
          <div>
            <label className={labelClass} htmlFor="sch-kind">نوع المشغّل</label>
            <select id="sch-kind" className={selectClass} value={triggerKind}
              onChange={e => { setTriggerKind(e.target.value as typeof triggerKind); setPreview(null) }}>
              <option value="schedule">جدولة زمنية</option>
              {taskType === 'coverage.sourcing' && <option value="business_event">حدث أعمال معتمد</option>}
            </select>
          </div>
          {triggerKind === 'schedule' ? (
            <>
              <div>
                <label className={labelClass} htmlFor="sch-recurrence">نمط الجدولة</label>
                <select id="sch-recurrence" className={selectClass} value={scheduleKind}
                  onChange={e => { setScheduleKind(e.target.value as typeof scheduleKind); setPreview(null) }}>
                  <option value="once">مرة واحدة</option>
                  <option value="recurring">تكرار كل عدد ثابت من الدقائق</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="sch-time">أول موعد (التوقيت المحلي)</label>
                <input id="sch-time" className={selectClass} type="datetime-local" value={nextLocal}
                  onChange={e => { setNextLocal(e.target.value); setPreview(null) }} />
              </div>
              {scheduleKind === 'recurring' && (
                <div>
                  <label className={labelClass} htmlFor="sch-interval">التكرار بالدقائق (5–525600)</label>
                  <input id="sch-interval" className={selectClass} type="number" min={5} max={525600}
                    value={intervalMinutes} onChange={e => { setIntervalMinutes(Number(e.target.value)); setPreview(null) }} />
                </div>
              )}
            </>
          ) : (
            <div>
              <label className={labelClass} htmlFor="sch-event">حدث الأعمال</label>
              <select id="sch-event" className={selectClass} value={eventType}
                onChange={e => setEventType(e.target.value)}>
                <option value="coverage.request.activated">تفعيل طلب التغطية</option>
                <option value="coverage.request.approved">اعتماد طلب التغطية</option>
              </select>
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="sch-overlap">عند وجود مهمة نشطة لنفس المصدر</label>
            <select id="sch-overlap" className={selectClass} value={overlapPolicy}
              onChange={e => setOverlapPolicy(e.target.value as typeof overlapPolicy)}>
              <option value="skip">تجاوز مع تسجيل السبب (skip)</option>
              <option value="defer">تأجيل ومحاولة لاحقة (defer)</option>
            </select>
          </div>
        </div>
        {taskType === 'services.promotion' && promotionReview && (
          <section className="mt-4 rounded-xl border border-primary/25 bg-muted/20 p-4 space-y-3">
            <h4 className="text-sm font-semibold">مراجعة الترويج V2 — بدون إرسال</h4>
            <p className="text-xs">الاتصال: {promotionReview.connection.name} · الجمهور الحالي: {promotionReview.audience.total} جهة</p>
            {promotionReview.blockers.length > 0 && <p role="alert" className="text-xs text-destructive">
              عوائق الترويج: {promotionReview.blockers.join('، ')}
            </p>}
            <div className="max-h-36 overflow-y-auto rounded-lg border p-2 space-y-1">
              {promotionReview.audience.contacts.map(c =>
                <p key={c.id} className="text-xs">{c.name || c.id.slice(0, 8)} · {c.phone || 'بدون رقم'}</p>)}
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={consentAcknowledged}
                onChange={e => setConsentAcknowledged(e.target.checked)} />
              أؤكد مراجعة أهلية التواصل والموافقة من جهات الاتصال المحددة.
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={approvalAcknowledged}
                onChange={e => setApprovalAcknowledged(e.target.checked)} />
              أعتمد هذه الحملة وجمهورها واتصالها وبصمتها لأغراض الجدولة.
            </label>
            {scheduleKind === 'recurring' && <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={recurringAcknowledged}
                onChange={e => setRecurringAcknowledged(e.target.checked)} />
              أوافق صراحة على التكرار، مع إعادة التحقق عند كل تشغيل وصلاحية مراجعة محدودة.
            </label>}
            <p className="text-xs text-muted-foreground">تُرفض الحملة إذا تغيّر الجمهور أو الاتصال أو النسخة المنشورة، وتنتهي الموافقة بعد 30 يومًا كحد أقصى.</p>
          </section>
        )}
        {preview && <div role="status" className="mt-4 rounded-xl border bg-muted/30 p-3 text-sm">
          <p className="font-medium">معاينة بلا إرسال</p>
          <p className="mt-1">{preview.notice}</p>
          {preview.nextFireAt && <p className="mt-1"><Clock3 className="ms-1 inline h-4 w-4" /> التشغيل المتوقع: {displayTime(preview.nextFireAt)}</p>}
        </div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy !== null || !agentId || !sourceId ||
              (version === 2 && !connectionId)} onClick={() => void inspect()}>
            <Eye className="me-2 h-4 w-4" /> {busy === 'preview' ? 'جارٍ التحقق…' : 'معاينة'}
          </Button>
          <Button disabled={busy !== null || !agentId || !sourceId || !promoReady || !coverageReady}
            onClick={() => void save()}>
            <Plus className="me-2 h-4 w-4" /> {busy === 'create' ? 'جارٍ الحفظ…' : 'حفظ كقاعدة موقوفة'}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> القواعد وسجل التشغيل</h3>
        {busy === 'load' && !catalog && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
        {catalog?.rules.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">لا توجد قواعد. أنشئ قاعدة موقوفة ثم راجعها قبل التمكين.</p>}
        {catalog?.rules.map(rule => {
          const agent = catalog.agents.find(a => a.id === rule.agentId)
          const overdue = rule.triggerKind === 'schedule' &&
            (!rule.nextFireAt || !Number.isFinite(Date.parse(rule.nextFireAt)) ||
              Date.parse(rule.nextFireAt) <= Date.now() + 60_000)
          return (
            <article key={rule.id} className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold">{rule.taskType === 'coverage.sourcing' ? 'تغطية' : 'ترويج الخدمات'} V{rule.version} · {agent?.name ?? rule.agentId.slice(0, 8)}</h4>
                  <p className="mt-1 text-xs text-muted-foreground">{rule.triggerKind === 'schedule'
                    ? (rule.scheduleKind === 'once' ? 'مرة واحدة' : 'كل ' + rule.intervalMinutes + ' دقيقة')
                    : 'حدث: ' + rule.eventType} · {statusName(rule.status)} · سياسة V{rule.policyVersion}</p>
                  <p className="mt-1 text-xs text-muted-foreground">الموعد القادم: {displayTime(rule.nextFireAt)} · التداخل: {rule.overlapPolicy === 'skip' ? 'تجاوز' : 'تأجيل'} · الفترات المتخطاة: {rule.skippedOccurrences}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {rule.status === 'paused' && <Button variant="outline" size="sm"
                    disabled={busy !== null} onClick={() => editingId === rule.id
                      ? setEditingId(null) : beginEdit(rule)}>
                    <Pencil className="me-1.5 h-4 w-4" /> {editingId === rule.id ? 'إغلاق التعديل' : 'تعديل'}
                  </Button>}
                  {rule.status !== 'cancelled' && <Button variant="outline" size="sm"
                    disabled={busy !== null} onClick={() => void cancelRule(rule)}>
                    <Ban className="me-1.5 h-4 w-4" /> إلغاء نهائي
                  </Button>}
                  {rule.firings.some(f => f.taskId) && onOpenTasks && <Button variant="outline"
                    size="sm" disabled={busy !== null} onClick={onOpenTasks}>
                    <ListChecks className="me-1.5 h-4 w-4" /> مهام الوكلاء
                  </Button>}
                  {rule.status === 'enabled' && <Button variant="outline" size="sm"
                    disabled={busy !== null} onClick={() => void changeStatus(rule, 'paused')}>
                    <PauseCircle className="me-1.5 h-4 w-4" /> إيقاف
                  </Button>}
                  {rule.status === 'paused' && <Button variant="outline" size="sm"
                    disabled={busy !== null || !catalog.enableAllowedInTest || overdue}
                    onClick={() => void changeStatus(rule, 'enabled')}>
                    <PlayCircle className="me-1.5 h-4 w-4" /> تمكين TEST
                  </Button>}
                </div>
              </div>
              {rule.status === 'paused' && !catalog.enableAllowedInTest && (
                <p role="status" className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                  {!catalog.testProjectVerified
                    ? 'تمكين TEST محظور: الخادم لا يثبت اتصاله بقاعدة Supabase TEST المعتمدة. راجع NEXT_PUBLIC_SUPABASE_URL وأعد التشغيل.'
                    : !catalog.schedulerTestGateConfigured
                      ? 'تمكين TEST متوقف: أضف WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST=1 إلى .env.local، أعد تشغيل WACRM ثم اضغط تحديث.'
                      : 'التمكين مقيد بإعدادات الخادم على TEST؛ راجع الإعدادات وأعد تحميل الصفحة.'}
                </p>
              )}
              {rule.status === 'paused' && overdue && (
                <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  انتهى موعد الجدولة. اضغط «تعديل» واختر موعدًا مستقبليًا يتجاوز دقيقة، ثم احفظ وأعد التمكين.
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">المصدر: {rule.subjectId?.slice(0, 12) ?? 'مُحدد بفلتر الحدث'} · معرّف القاعدة: {rule.id.slice(0, 12)}
              {rule.cancelledAt ? ' · أُلغيت: ' + displayTime(rule.cancelledAt) : ''}
              </p>
              {editingId === rule.id && rule.status === 'paused' && (
                <div className="mt-4 space-y-3 rounded-xl border bg-muted/30 p-4">
                  <h5 className="text-sm font-semibold">تعديل السياسة V{rule.policyVersion}</h5>
                  <p className="text-xs leading-6 text-muted-foreground">يسمح بتغيير الموعد والفاصل وسياسة التداخل فقط. الوكيل والمصدر والنسخة المنشورة ثابتة. تُتجاوز الحجوزات المعلقة السابقة مع الاحتفاظ بسجلها، وتبقى الجدولة موقوفة بعد الحفظ.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {rule.triggerKind === 'schedule' && <>
                      <div>
                        <label className={labelClass} htmlFor={'edit-kind-' + rule.id}>نوع الجدولة</label>
                        <select id={'edit-kind-' + rule.id} className={selectClass}
                          value={editKind} onChange={e => setEditKind(e.target.value as typeof editKind)}>
                          <option value="once">مرة واحدة</option>
                          <option value="recurring">تكرار كل عدد ثابت من الدقائق</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelClass} htmlFor={'edit-time-' + rule.id}>الموعد القادم — {timezone}</label>
                        <input id={'edit-time-' + rule.id} className={selectClass}
                          type="datetime-local" value={editLocalTime}
                          onChange={e => setEditLocalTime(e.target.value)} />
                      </div>
                      {editKind === 'recurring' && <div>
                        <label className={labelClass} htmlFor={'edit-interval-' + rule.id}>التكرار بالدقائق</label>
                        <input id={'edit-interval-' + rule.id} className={selectClass}
                          type="number" min={5} max={525600} value={editInterval}
                          onChange={e => setEditInterval(Number(e.target.value))} />
                      </div>}
                    </>}
                    <div>
                      <label className={labelClass} htmlFor={'edit-overlap-' + rule.id}>سياسة التداخل</label>
                      <select id={'edit-overlap-' + rule.id} className={selectClass}
                        value={editOverlap} onChange={e => setEditOverlap(e.target.value as typeof editOverlap)}>
                        <option value="skip">تجاوز (skip)</option>
                        <option value="defer">تأجيل (defer)</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy !== null} onClick={() => void saveEdit(rule)}>
                      حفظ التعديل بدون تفعيل
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                      تراجع
                    </Button>
                  </div>
                </div>
              )}
              {rule.firings.length > 0 && <div className="mt-4 overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[520px] text-start text-xs">
                  <thead className="bg-muted/50 text-muted-foreground"><tr>
                    <th className="p-2 text-start">الوقت</th><th className="p-2 text-start">حالة firing</th><th className="p-2 text-start">محاولات</th><th className="p-2 text-start">السبب / Task</th><th className="p-2 text-start">حالة المهمة</th>
                  </tr></thead>
                  <tbody>{rule.firings.map(f => <tr key={f.id} className="border-t">
                    <td className="p-2">{displayTime(f.scheduledFor ?? f.createdAt)}</td>
                    <td className="p-2 font-medium">{statusName(f.status)}</td>
                    <td className="p-2">{f.attempts}</td>
                    <td className="p-2">{f.skipReason ?? f.reason ?? (f.taskId ? 'Task ' + f.taskId.slice(0, 8) : '—')}</td>
                    <td className="p-2">{f.taskStatus ? statusName(f.taskStatus) : f.taskId ? 'تحقق من المهام' : '—'}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
            </article>
          )
        })}
      </section>
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-6">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>تعديل السياسة لا يغيّر المصدر أو الوكيل؛ ولتغييرهما ألغِ السياسة وأنشئ أخرى. الإلغاء نهائي لكنه لا يلغي Task بدأ أو رسالة واتساب أُرسلت. هذه الحالات تُدار من تبويب «مهام الوكلاء». تمكين الجدولة مقيد بـTEST؛ اختبار الواجهة والقبول الحي مؤجلان.</p>
      </div>
    </div>
  )
}
