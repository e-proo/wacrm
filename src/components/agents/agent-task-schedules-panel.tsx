'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Clock3, PauseCircle, PlayCircle, RefreshCw, ShieldCheck, Eye, Plus, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Firing = {
  id: string; status: string; attempts: number; createdAt: string
  scheduledFor: string | null; availableAt: string; taskId: string | null
  skipReason: string | null; reason: string | null
}
type Rule = {
  id: string; taskType: string; version: number; agentId: string
  triggerKind: 'schedule' | 'business_event'; status: string
  scheduleKind: 'once' | 'recurring' | null; nextFireAt: string | null
  intervalMinutes: number | null; eventType: string | null; subjectId: string | null
  policyVersion: number; overlapPolicy: 'skip' | 'defer'
  approvedRevisionId: string | null; skippedOccurrences: number
  createdAt: string; firings: Firing[]
}
type Catalog = {
  rules: Rule[]
  agents: Array<{ id: string; name: string; publishedRevisionId: string | null }>
  coverageRequests: Array<{ id: string; status: string }>
  services: Array<{ id: string; name: string; status: string }>
  maxPendingPerAccount: number
  taskWorkerEnabled: boolean
  enableAllowedInTest: boolean
}
type Preview = { mode: string; nextFireAt: string | null; intervalMinutes: number | null; notice: string }

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
    dead: 'توقفت بعد المحاولات', skipped: 'تم تجاوز التداخل',
  } as Record<string, string>)[status] ?? status
}
function nextSubmission(): string {
  return crypto.randomUUID()
}

/** A strictly no-send admin editor. Create only PAUSED policies; start is separately
 * operator-confirmed and additionally server-gated in TEST.
 */
export function AgentTaskSchedulesPanel() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [timezone, setTimezone] = useState('UTC')
  const [agentId, setAgentId] = useState('')
  const [taskType, setTaskType] = useState<'coverage.sourcing' | 'services.promotion'>('coverage.sourcing')
  const [version, setVersion] = useState<1 | 2>(2)
  const [sourceId, setSourceId] = useState('')
  const [triggerKind, setTriggerKind] = useState<'schedule' | 'business_event'>('schedule')
  const [scheduleKind, setScheduleKind] = useState<'once' | 'recurring'>('once')
  const [eventType, setEventType] = useState('coverage.request.activated')
  const [nextLocal, setNextLocal] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [overlapPolicy, setOverlapPolicy] = useState<'skip' | 'defer'>('skip')
  const [submissionId, setSubmissionId] = useState('')

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    setNextLocal(localDateTime(new Date(Date.now() + 10 * 60_000)))
  }, [])

  const reload = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      const data = await json<Catalog>(await fetch('/api/agent-tasks/triggers', { cache: 'no-store' }))
      setCatalog(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تحميل قواعد الجدولة.')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

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
    overlapPolicy,
  }), [agentId, submissionId, taskType, version, triggerKind, scheduleKind, nextLocal,
    intervalMinutes, eventType, sourceId, overlapPolicy])

  const inspect = async () => {
    setBusy('preview')
    setError(null)
    setPreview(null)
    try {
      const result = await json<Preview>(await fetch('/api/agent-tasks/triggers/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft(submissionId || nextSubmission())),
      }))
      setPreview(result)
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
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذّر حفظ الجدولة.') }
    finally { setBusy(null) }
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

      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {success && <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">{success}</p>}

      <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><Plus className="h-4 w-4" /> قاعدة جديدة</h3>
        <p className="mb-5 text-xs text-muted-foreground">التوقيت المعروض حسب {timezone}. التكرار بالدقائق المنقضية، وليس تقويمًا شهريًا أو توقيتًا صيفيًا.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="sch-agent">الوكيل المنشور</label>
            <select id="sch-agent" className={selectClass} value={agentId} onChange={e => { setAgentId(e.target.value); setPreview(null) }}>
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
              setTaskType(value); setVersion(value === 'coverage.sourcing' ? 2 : 1)
              setTriggerKind('schedule'); setSourceId(''); setPreview(null)
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
            <select id="sch-source" className={selectClass} value={sourceId} onChange={e => { setSourceId(e.target.value); setPreview(null) }}>
              <option value="">اختر المصدر ضمن الحساب</option>
              {subjectOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
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
        {preview && <div role="status" className="mt-4 rounded-xl border bg-muted/30 p-3 text-sm">
          <p className="font-medium">معاينة بلا إرسال</p>
          <p className="mt-1">{preview.notice}</p>
          {preview.nextFireAt && <p className="mt-1"><Clock3 className="ms-1 inline h-4 w-4" /> التشغيل المتوقع: {displayTime(preview.nextFireAt)}</p>}
        </div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy !== null || !agentId || !sourceId} onClick={() => void inspect()}>
            <Eye className="me-2 h-4 w-4" /> {busy === 'preview' ? 'جارٍ التحقق…' : 'معاينة'}
          </Button>
          <Button disabled={busy !== null || !agentId || !sourceId} onClick={() => void save()}>
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
                  {rule.status === 'enabled' && <Button variant="outline" size="sm"
                    disabled={busy !== null} onClick={() => void changeStatus(rule, 'paused')}>
                    <PauseCircle className="me-1.5 h-4 w-4" /> إيقاف
                  </Button>}
                  {rule.status === 'paused' && <Button variant="outline" size="sm"
                    disabled={busy !== null || !catalog.enableAllowedInTest}
                    onClick={() => void changeStatus(rule, 'enabled')}>
                    <PlayCircle className="me-1.5 h-4 w-4" /> تمكين TEST
                  </Button>}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">المصدر: {rule.subjectId?.slice(0, 12) ?? 'مُحدد بفلتر الحدث'} · معرّف القاعدة: {rule.id.slice(0, 12)}</p>
              {rule.firings.length > 0 && <div className="mt-4 overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[520px] text-start text-xs">
                  <thead className="bg-muted/50 text-muted-foreground"><tr>
                    <th className="p-2 text-start">الوقت</th><th className="p-2 text-start">حالة firing</th><th className="p-2 text-start">محاولات</th><th className="p-2 text-start">السبب / Task</th>
                  </tr></thead>
                  <tbody>{rule.firings.map(f => <tr key={f.id} className="border-t">
                    <td className="p-2">{displayTime(f.scheduledFor ?? f.createdAt)}</td>
                    <td className="p-2 font-medium">{statusName(f.status)}</td>
                    <td className="p-2">{f.attempts}</td>
                    <td className="p-2">{f.skipReason ?? f.reason ?? (f.taskId ? 'Task ' + f.taskId.slice(0, 8) : '—')}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
            </article>
          )
        })}
      </section>
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-6">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>حالة القاعدة تختلف عن حالة firing والمهمة ورسالة واتساب. لا يُعادل نجاح الجدولة نجاح الإرسال. تمكين الجدولة مقيد بـTEST وبموافقة إضافية؛ الاختبارات الحية مؤجلة.</p>
      </div>
    </div>
  )
}
