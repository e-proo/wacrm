'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, Bot, CheckCircle2, ClipboardCheck,
  LockKeyhole, Megaphone, MessageCircle, RefreshCw, Send, ShieldCheck,
  Sparkles, Users, Wifi, Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Service = { id: string; name: string; code: string }
type Agent = { id: string; name: string; published: boolean; promotionV2: boolean;
  revisionNumber: number | null; promotionAudienceConfigured: boolean;
  promotionRequiredTagIds: string[] }
type Connection = { id: string; name: string; provider: 'meta_cloud' | 'openwa'; status: string; ready: boolean }
type Task = { id: string; status: string; version: number; serviceId: string | null; createdAt: string }
type Tag = { id: string; name: string; color: string | null }
type Catalog = {
  services: Service[]; agents: Agent[]; connections: Connection[]; tags: Tag[];
  recentTasks: Task[]; launchEnabled: boolean
}
type Preview = {
  previewOnly: true; readyForApproval: boolean; readyForLaunch: false;
  reviewedAt: string; expiresAt: string; fingerprint: string;
  service: { id: string; name: string; publicDescription: string | null };
  agent: { id: string; name: string; revisionId: string };
  connection: { id: string; name: string; provider: string };
  audience: {
    total: number; policyMax: number; requiredTagIds: string[]; excludedTagIds: string[];
    contacts: Array<{ id: string; name: string | null; phone: string | null; reason: string | null }>
  };
  message: { kind: 'template' | 'text'; body: string };
  template: { name: string; language: string; status: string; id: string | null } | null;
  blockers: string[];
}
type Launched = { task: { id: string }; created: boolean }

const reasons: Record<string, string> = {
  SERVICE_PROMOTION_AUDIENCE_EMPTY: 'لا توجد جهات اتصال ضمن الوسوم المحددة.',
  SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT: 'الجمهور أكبر من الحد المحدد في إعدادات الوكيل.',
  SERVICE_PROMOTION_TAG_OUTSIDE_ACCOUNT: 'وسم واحد أو أكثر لا يخص هذا الحساب.',
  SERVICE_PROMOTION_CONTACT_BLOCKED: 'هناك جهات محظورة أو أرقام غير صالحة. راجعها قبل المتابعة.',
  SERVICE_PROMOTION_CONNECTION_PAUSED: 'الجلسة موقوفة أو دائرة الحماية مفعّلة.',
  SERVICE_PROMOTION_RUNTIME_NOT_READY: 'محرك مهام الوكلاء أو إحدى بوابات الإرسال غير مفعّلة لهذا الحساب.',
  SERVICE_PROMOTION_WORKER_PAUSED: 'عامل المهام متوقف؛ لن يبدأ تنفيذ هذه الحملة.',
  SERVICE_PROMOTION_OPENWA_PILOT_REQUIRED: 'يجب تفعيل Pilot على جلسة OpenWA وتوثيق كل مستهدف.',
  SERVICE_PROMOTION_MESSAGE_FACTS_INVALID: 'اسم الخدمة غير ملائم للرسالة الترويجية (تحقق من الطول والمحارف).',
  SERVICE_PROMOTION_CONNECTION_UNAVAILABLE: 'الجلسة المختارة غير جاهزة.',
  SERVICE_PROMOTION_APPROVED_TEMPLATE_MISSING: 'القالب العربي غير معتمد، أو متغيراته غير صالحة.',
  SERVICE_PROMOTION_OPENWA_TEST_ONLY: 'ترويج OpenWA محدود ببيئة TEST.',
  SERVICE_PROMOTION_LIVE_ACCEPTANCE_NOT_AUTHORIZED: 'التشغيل متوقف حتى اعتماد اختبارات TEST الحية.',
  SERVICE_PROMOTION_REVIEW_STALE: 'تغير الجمهور أو القالب أو إعداد الوكيل. أعد المعاينة.',
  SERVICE_PROMOTION_REVIEW_EXPIRED: 'انتهت صلاحية المعاينة. أعد مراجعتها.',
  SERVICE_PROMOTION_ALREADY_ACTIVE: 'هناك حملة ترويج نشطة للخدمة نفسها.',
  SERVICE_PROMOTION_V2_BINDING_REQUIRED: 'الوكيل لا يحتوي على ربط services.promotion@2 في مراجعته المنشورة.',
  SERVICE_PROMOTION_SEGMENT_REQUIRED: 'الوكيل يدعم ترويج الخدمات V2، لكن لم تُحدّد وسوم الجمهور المستهدف في مراجعته المنشورة.',
  SERVICE_PROMOTION_SERVICE_SCOPE_DENIED: 'الخدمة المختارة خارج الخدمات المسموح بها للوكيل.',
  SERVICE_PROMOTION_SELECTOR_UNSUPPORTED: 'يتطلب ترويج الخدمات جمهورًا محددًا بالوسوم فقط، دون محددات مناطق إضافية.',
  SERVICE_PROMOTION_APPROVAL_REQUIRED: 'يجب اختيار سياسة اعتماد المهمة بدل عدم الاعتماد.',
}
function humanReason(reason: string | null) {
  if (reason === 'opted_out_or_blocked') return 'حظر / إلغاء اشتراك'
  if (reason === 'contact_missing') return 'جهة غير متاحة'
  if (reason === 'invalid_phone') return 'رقم غير صالح'
  return 'مبدئيًا صالح؛ يتطلب موافقة وفحص المزود'
}
async function json<T>(response: Response): Promise<T> {
  let result: Record<string, unknown>
  try {
    result = JSON.parse(await response.text()) as Record<string, unknown>
  } catch {
    throw new Error('أعاد الخادم استجابة غير JSON. تأكد من تشغيل إصدار WACRM الصحيح.')
  }
  if (!response.ok) {
    const code = typeof result.code === 'string' ? result.code : ''
    const fallback = typeof result.error === 'string' ? result.error : 'تعذر إكمال الطلب.'
    throw new Error(reasons[code] ?? reasons[fallback] ?? fallback)
  }
  return result as T
}
const stages = ['تحديد الحملة', 'الجمهور والأمان', 'الموافقة النهائية']

export function ServicePromotionComposer(props: { onConfigureAgent?: (agentId: string) => void } = {}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [serviceId, setServiceId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [consent, setConsent] = useState(false)
  const [approved, setApproved] = useState(false)
  const [submissionId, setSubmissionId] = useState('')
  const [busy, setBusy] = useState<'load' | 'preview' | 'launch' | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [launched, setLaunched] = useState<Launched | null>(null)

  const reload = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      const data = await json<Catalog>(await fetch('/api/agent-tasks/promotion', { cache: 'no-store' }))
      setCatalog(data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذر تحميل بيانات الترويج.')
    } finally {
      setBusy(null)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  function reset() {
    setPreview(null); setConsent(false); setApproved(false)
    setSubmissionId(''); setLaunched(null); setError(null)
  }

  const currentAgent = catalog?.agents.find(a => a.id === agentId)
  const currentConnection = catalog?.connections.find(c => c.id === connectionId)
  const selected = Boolean(serviceId && currentAgent?.promotionV2 &&
    currentAgent.promotionAudienceConfigured && currentConnection?.ready)
  const valid = Boolean(preview && preview.service.id === serviceId &&
    preview.agent.id === agentId && preview.connection.id === connectionId &&
    Date.parse(preview.expiresAt) > Date.now())
  const canLaunch = Boolean(valid && preview?.readyForApproval &&
    catalog?.launchEnabled && consent && approved && !busy && !launched)

  async function inspect() {
    if (!selected) return
    reset()
    setBusy('preview')
    try {
      const search = new URLSearchParams({ serviceId, agentId, connectionId })
      const result = await json<Preview>(
        await fetch('/api/agent-tasks/promotion/preview?' + search, { cache: 'no-store' }),
      )
      setPreview(result)
      setSubmissionId(crypto.randomUUID())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذرت المعاينة.')
    } finally {
      setBusy(null)
    }
  }
  async function launch() {
    if (!canLaunch || !preview || !submissionId) return
    setBusy('launch')
    setError(null)
    try {
      const result = await json<Launched>(await fetch('/api/agent-tasks/promotion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId, agentId, connectionId, submissionId,
          fingerprint: preview.fingerprint, reviewedAt: preview.reviewedAt,
          consentAcknowledged: consent, approvalAcknowledged: approved,
        }),
      }))
      setLaunched(result)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذر إطلاق المهمة.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div dir="rtl" className="mx-auto max-w-7xl space-y-5 pb-10">
      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-bl from-primary/10 via-background to-background p-5 shadow-sm sm:p-7">
        <div className="pointer-events-none absolute -top-16 -left-16 size-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="rounded-2xl border border-primary/20 bg-primary/10 p-3 text-primary"><Megaphone className="size-6" /></span>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">وكيل ترويج الخدمات</h2>
                <span className="rounded-full border bg-background/80 px-2.5 py-1 text-xs">Service Promotion V2</span>
              </div>
              <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                جهّز عرض خدمة حقيقيًا، راجع المستهدفين والرسالة والجلسة، ثم اعتمد الحملة عند فتح بوابة TEST.
                لا يتم الإرسال بمجرد المعاينة.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={busy !== null}>
            <RefreshCw className="me-2 size-4" />تحديث
          </Button>
        </div>
        <div className="relative mt-6 grid grid-cols-3 gap-2">
          {stages.map((stage, i) => {
            const active = i === 0 || i === 1 && preview !== null ||
              i === 2 && valid && preview?.readyForApproval
            return <div key={stage} className={['flex items-center gap-2 rounded-xl border p-2.5 sm:p-3',
              active ? 'border-primary/30 bg-primary/5' : 'bg-background/50 text-muted-foreground'].join(' ')}>
              <span className={['flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                active ? 'bg-primary text-primary-foreground' : 'bg-muted'].join(' ')}>{i + 1}</span>
              <span className="text-xs font-medium sm:text-sm">{stage}</span>
            </div>
          })}
        </div>
      </section>

      {catalog && !catalog.launchEnabled && <div role="status"
        className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm">
        <LockKeyhole className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div><p className="font-semibold">وضع التجهيز والمعاينة فقط</p>
          <p className="mt-1 leading-6 text-muted-foreground">
            لم تُفتح بوابة الإرسال الحي. يسمح هذا القسم بمراجعة الخدمة والقالب والمستهدفين،
            إلى حين اجتياز الاختبارات التقنية واعتماد Pilot يدويًا على TEST.
          </p></div>
      </div>}
      {error && <div role="alert" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</div>}
      {launched && <div role="status" className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
        <CheckCircle2 className="mt-0.5 size-5 text-primary" />
        <div><p className="font-semibold">{launched.created ? 'تم إنشاء المهمة' : 'المهمة منشأة مسبقًا'}</p>
          <p className="font-mono text-xs text-muted-foreground" dir="ltr">{launched.task.id}</p>
          <p className="text-xs text-muted-foreground">راقب التنفيذ من تبويب «مهام الوكلاء».</p>
        </div>
      </div>}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(310px,1fr)]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20"><CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" /> 1. تفاصيل الحملة
            </CardTitle></CardHeader>
            <CardContent className="space-y-5 pt-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm"><span className="flex items-center gap-2 font-medium">
                  <Megaphone className="size-4 text-muted-foreground" /> الخدمة النشطة
                </span><select value={serviceId} disabled={busy !== null}
                  onChange={e => { setServiceId(e.target.value); reset() }}
                  className="h-11 w-full rounded-lg border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="">اختر الخدمة...</option>
                  {(catalog?.services ?? []).map(s => <option key={s.id} value={s.id}>{s.name} · {s.code}</option>)}
                </select></label>
                <label className="space-y-2 text-sm"><span className="flex items-center gap-2 font-medium">
                  <Bot className="size-4 text-muted-foreground" /> الوكيل المنشور
                </span><select value={agentId} disabled={busy !== null}
                  onChange={e => { setAgentId(e.target.value); reset() }}
                  className="h-11 w-full rounded-lg border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="">اختر الوكيل...</option>
                  {(catalog?.agents ?? []).map(a => <option key={a.id} value={a.id} disabled={!a.promotionV2}>
                    {a.name}{a.promotionV2 ? '' : ' · يحتاج ترويج V2'}
                  </option>)}
                </select></label>
              </div>
              {currentAgent?.promotionV2 && !currentAgent.promotionAudienceConfigured && (
                <div role="alert" className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-1 size-4 shrink-0 text-amber-600" />
                    <div className="space-y-1">
                      <p className="text-sm font-semibold">الوكيل يدعم V2 بالفعل، لكن الجمهور غير مُعدّ</p>
                      <p className="text-xs leading-6 text-muted-foreground">
                        مراجعة الوكيل المنشورة {currentAgent.revisionNumber ?? 'الحالية'} تحتوي على
                        services.promotion@2، لكن لا يوجد أي وسم ضمن «وسوم الجمهور المستهدف».
                        افتح مسودة جديدة، اختر الوسم من قائمته باسمه، ثم احفظ وانشر المراجعة الجديدة.
                      </p>
                      {catalog && catalog.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {catalog.tags.slice(0, 8).map(tag => (
                            <span key={tag.id} className="rounded-full border bg-background px-2.5 py-1 text-xs">
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        يلزم أيضًا ربط جهات اتصال مناسبة بالوسم؛ مجرد وجود الوسم لا يُنشئ جمهورًا.
                      </p>
                    </div>
                  </div>
                  {props.onConfigureAgent && (
                    <Button type="button" size="sm" variant="outline"
                      onClick={() => props.onConfigureAgent?.(currentAgent.id)}>
                      <Bot className="me-2 size-4" /> فتح إعدادات هذا الوكيل
                    </Button>
                  )}
                </div>
              )}
              {currentAgent && !currentAgent.promotionV2 && (
                <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-6">
                  لا تحتوي المراجعة المنشورة على ربط services.promotion@2. انشر مسودة تدعم نوع المهمة المطلوب.
                </p>
              )}
              <label className="block space-y-2 text-sm"><span className="flex items-center gap-2 font-medium">
                <Wifi className="size-4 text-muted-foreground" /> اتصال WhatsApp الخاص بهذه المهمة
              </span><select value={connectionId} disabled={busy !== null}
                onChange={e => { setConnectionId(e.target.value); reset() }}
                className="h-11 w-full rounded-lg border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">اختر جلسة محددة...</option>
                {(catalog?.connections ?? []).map(c => <option key={c.id} value={c.id} disabled={!c.ready}>
                  {c.name} · {c.provider === 'openwa' ? 'OpenWA' : 'Meta Cloud'}{c.ready ? '' : ' · غير جاهزة'}
                </option>)}
              </select><span className="block text-xs leading-5 text-muted-foreground">
                الجلسة ثابتة لكل مهمة، ولا يُستخدم مزود بديل دون موافقة جديدة.
              </span></label>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-3">
                <p className="max-w-sm text-xs leading-6 text-muted-foreground">
                  يُستخرج الجمهور من وسوم Builder المنشورة في الوكيل. لا تُنشأ جهات اتصال جديدة.
                  {!currentAgent?.promotionAudienceConfigured && currentAgent?.promotionV2
                    ? ' اختر وسمًا للجمهور أولًا لتفعيل زر المعاينة.' : ''}
                </p>
                <Button disabled={!selected || busy !== null} onClick={() => void inspect()}>
                  {busy === 'preview' ? <Loader2 className="me-2 size-4 animate-spin" /> :
                    <ArrowLeft className="me-2 size-4" />}
                  معاينة الجمهور والرسالة
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20"><CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4 text-primary" /> 2. الجمهور والتحقق من الأمان
            </CardTitle></CardHeader>
            <CardContent className="space-y-4 pt-5">
              {!preview ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Users className="size-7 opacity-30" />اختر الخيارات أعلاه ثم اطلب المعاينة.
              </div> : <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><span className="rounded-lg bg-primary/10 px-3 py-2 text-xl font-semibold text-primary">
                    {preview.audience.total}</span>
                    <span className="text-sm">مستهدفًا <span className="block text-xs text-muted-foreground">
                      من أصل {preview.audience.policyMax} مسموحًا</span></span></div>
                  <span className={['rounded-full border px-3 py-1.5 text-xs',
                    preview.readyForApproval
                      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'].join(' ')}>
                    {preview.readyForApproval ? 'جاهز للموافقة' : 'توجد موانع'}
                  </span>
                </div>
                {preview.blockers.length > 0 && <div role="alert"
                  className="space-y-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                  {preview.blockers.map(b => <p key={b} className="flex items-start gap-2 text-xs leading-6">
                    <AlertTriangle className="mt-1 size-4 shrink-0 text-amber-600" />
                    {reasons[b] ?? b}</p>)}
                </div>}
                <div className="grid gap-3 rounded-xl border bg-muted/20 p-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold">الوسوم المطلوبة</p>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.audience.requiredTagIds.map(id => <span key={id}
                        className="rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs text-primary">
                        {catalog?.tags.find(tag => tag.id === id)?.name || id.slice(0, 8)}
                      </span>)}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-semibold">الوسوم المستبعدة</p>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.audience.excludedTagIds.length > 0
                        ? preview.audience.excludedTagIds.map(id => <span key={id}
                            className="rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground">
                            {catalog?.tags.find(tag => tag.id === id)?.name || id.slice(0, 8)}
                          </span>)
                        : <span className="text-xs text-muted-foreground">لا يوجد استبعاد إضافي</span>}
                    </div>
                  </div>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pe-1">
                  {preview.audience.contacts.map((c, i) => <div key={c.id}
                    className="flex items-center gap-3 rounded-lg border p-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name || 'جهة اتصال'}</p>
                      <p dir="ltr" className="text-xs text-muted-foreground">{c.phone || c.id.slice(0, 8)}</p>
                    </div>
                    <span className="max-w-28 text-left text-xs text-muted-foreground">{humanReason(c.reason)}</span>
                  </div>)}
                </div>
                <p className="text-xs leading-6 text-muted-foreground">
                  يُعاد فحص الحظر والموافقة والحدود والاتصال قبل اعتماد المهمة وقبل dispatch.
                </p>
              </>}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20"><CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="size-4 text-primary" /> الرسالة الافتتاحية
            </CardTitle></CardHeader>
            <CardContent className="space-y-4 pt-5">
              <div className="rounded-2xl border bg-muted/20 p-4">
                <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{currentConnection?.provider === 'openwa' ? 'OpenWA · نص ثابت' : 'Meta Cloud · قالب'}</span>
                  <ShieldCheck className="size-4" />
                </div>
                <div className="ms-auto max-w-[95%] rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3 text-sm leading-7 shadow-sm">
                  <p className="whitespace-pre-wrap break-words">{preview?.message.body ||
                    'ستظهر هنا الرسالة الفعلية بعد معاينة الخدمة والجلسة والجمهور.'}</p>
                </div>
              </div>
              {preview?.template && <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
                <span>قالب Meta</span><span dir="ltr" className="font-mono">
                  {preview.template.name} · {preview.template.language}</span>
              </div>}
              <p className="text-xs leading-6 text-muted-foreground">
                لا يكتب النموذج رسالة افتتاحية حرة، ولا يختار محرك الإرسال.
                تطبق سياسات المزود ومطابقة نتائج الإرسال في WACRM.
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20"><CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="size-4 text-primary" /> 3. المراجعة والموافقة
            </CardTitle></CardHeader>
            <CardContent className="space-y-4 pt-5">
              {preview ? <div className="space-y-2 rounded-xl border p-3 text-xs">
                <p><strong>الجلسة:</strong> {preview.connection.name} · {preview.connection.provider}</p>
                <p><strong>عدد المستهدفين:</strong> {preview.audience.total}</p>
                <p className="text-muted-foreground">صالحة للمراجعة لمدة 10 دقائق، ثم يجب إعادة معاينتها.</p>
              </div> : <p className="text-sm text-muted-foreground">
                تظهر خيارات الموافقة بعد المعاينة الآمنة.
              </p>}
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-6">
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={consent}
                  disabled={!valid || !preview?.readyForApproval || busy !== null}
                  onChange={e => setConsent(e.target.checked)} />
                <span>أؤكد أن لدي موافقة صريحة وصالحة للتواصل عبر واتساب مع كل مستهدف.
                  <small className="block text-muted-foreground">
                    هذا إقرار مسؤول، وليس إثباتًا آليًا للموافقة؛ لا يرفع حظر المستهدف أو حدود المزود.
                  </small>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-6">
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={approved}
                  disabled={!valid || !preview?.readyForApproval || busy !== null}
                  onChange={e => setApproved(e.target.checked)} />
                <span>راجعت الرسالة والجمهور والحدود والجلسة وأوافق على إنشاء مهمة الترويج عند تفعيل TEST.</span>
              </label>
              <Button className="w-full" disabled={!canLaunch} onClick={() => void launch()}>
                {busy === 'launch' ? <Loader2 className="me-2 size-4 animate-spin" /> :
                  <Send className="me-2 size-4" />}
                {catalog?.launchEnabled ? 'اعتماد مهمة الترويج على TEST' : 'الإطلاق مغلق — المعاينة فقط'}
              </Button>
              <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
                <LockKeyhole className="size-4 shrink-0" />
                لن نفعّل Pilot أو ننقل الاتصال إلى مزود آخر تلقائيًا.
              </p>
            </CardContent>
          </Card>
          {(catalog?.recentTasks.length ?? 0) > 0 && <Card>
            <CardHeader><CardTitle className="text-sm">أحدث مهام الترويج</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {catalog!.recentTasks.slice(0, 5).map(task => <div key={task.id}
                className="flex items-center justify-between gap-2 border-b py-2 text-xs last:border-b-0">
                <span dir="ltr" className="font-mono text-muted-foreground">{task.id.slice(0, 8)}</span>
                <span>{task.status} · V{task.version}</span>
              </div>)}
            </CardContent>
          </Card>}
        </div>
      </div>
    </div>
  )
}
