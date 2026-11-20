'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertCircle, ArrowLeftRight, BookOpen, CheckCircle2, ChevronDown,
  CircleHelp, ClipboardCheck, ClipboardCopy, ExternalLink, FileText,
  HeartHandshake, LifeBuoy, Loader2, LockKeyhole, RefreshCw,
  Search, ShieldAlert, ShieldCheck, ShieldOff, Wrench,
} from 'lucide-react'

import { useAuth } from '@/hooks/use-auth'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  OPENWA_SUPPORT_FAQS, OPENWA_SUPPORT_GUIDES, OPENWA_SUPPORT_PROCEDURES,
  OPENWA_SUPPORT_ROLES, OPENWA_SUPPORT_SEVERITIES, OPENWA_SUPPORT_TOPICS,
  findOpenWASupportProcedure, localizeSupport, searchOpenWASupport,
  type SupportDestination, type SupportTopic, type SupportSeverity,
} from '@/lib/whatsapp/transport/openwa/support-playbooks'
import {
  deriveOpenWASupportSnapshot, formatOpenWASupportHandoff,
  type SafeSupportSnapshot, type SupportSource,
} from '@/lib/whatsapp/transport/openwa/support-diagnostics'

type SupportView = 'incidents' | 'guides' | 'diagnostics' | 'faq'
const arCopy = {
  title: 'مركز المساعدة والتشغيل',
  subtitle: 'دليل عملي للمسؤولين: تشخيص الحوادث، إجراءات الاستعادة، التصعيد، ومراجعة الحالة من دون إرسال أو كشف أسرار.',
  incidentTab: 'دليل معالجة الأعطال',
  guidanceOnly: 'إرشاد فقط · لا إرسال',
  guideTab: 'إجراءات التشغيل',
  diagnosticTab: 'فحص الحالة الآمن',
  faqTab: 'الأسئلة الشائعة',
  search: 'ابحث عن مشكلة أو رمز خطأ، مثل ACK أو 503 أو QR',
  allTopics: 'جميع الموضوعات',
  cases: 'حالات مسجلة في دليل الدعم',
  findCase: 'اختر المشكلة التي تواجهها',
  incidentEmpty: 'لا توجد نتائج لهذا البحث. جرّب مصطلحًا آخر أو أزل الفلتر.',
  severity: 'الأولوية',
  owner: 'المسؤول عن الإجراء',
  symptom: 'الأعراض المحتملة',
  procedure: 'خطوات التعامل الآمن',
  avoid: 'لا تفعل',
  escalate: 'متى وإلى من نصعّد؟',
  stepsDone: 'الخطوات التي راجعتها',
  resetSteps: 'إعادة تعيين قائمة المراجعة',
  openSection: 'الانتقال للقسم المناسب',
  noAccess: 'يمكنك قراءة الإرشادات. إجراءات الإدارة والفحص تتطلب صلاحية مسؤول أو مالك الحساب.',
  noAutomaticAction: 'هذه الخطوات إرشادية؛ وضع علامة لا يغيّر قاعدة البيانات ولا يوقف عاملًا ولا يرسل رسالة.',
  guideIntro: 'إجراءات تشغيل خطوة بخطوة. لا تنفذ أي إجراء حساس إلا من واجهته الرسمية وبالصلاحيات المناسبة.',
  faqIntro: 'إجابات عملية عن مزودي WhatsApp والخصوصية والموافقات والتسوية وحدود بيئة TEST.',
  auditSafe: 'عزل الحسابات وحماية البيانات',
  auditSafeDesc: 'لا تضع مفاتيح API أو QR أو HMAC أو JID أو أرقام الهواتف أو الرسائل في تذاكر الدعم. عند الاشتباه بتسريب أو اختلاط بيانات استخدم إجراءات P0.',
  diagnosticsTitle: 'فحص تشخيصي للقراءة فقط',
  diagnosticsDesc: 'يستعلم عند الضغط فقط عن حالة الموافقات والجلسات عبر واجهات WACRM الموجودة؛ لا يتصل مباشرة ببوابة OpenWA ولا يبدأ إرسالًا أو يعيد محاولة.',
  runCheck: 'فحص الحالة الآن',
  checking: 'جارٍ قراءة الحالة',
  diagUnrun: 'لم يُجرَ فحص بعد؛ لا يمكن استنتاج حالة أي جلسة أو موافقة.',
  diagOnlyAdmin: 'الفحص يتطلب صلاحية مسؤول/مالك حساب. لا تُجلب بيانات الحساب دون تفويض.',
  diagPartial: 'نتائج جزئية أو غير موثقة. لا تعتبر عدم توفر البيانات حالة سليمة أو قائمة فارغة.',
  diagComplete: 'اكتمل الفحص للقراءة فقط. هذا ليس اختبارًا حيًا للإرسال أو إثباتًا للتسليم.',
  checkedAt: 'وقت الفحص',
  policy: 'سياسة OpenWA',
  consent: 'موافقة الحساب',
  approved: 'معتمدة في قاعدة البيانات',
  notApproved: 'غير معتمدة',
  current: 'سارية',
  notCurrent: 'غير سارية',
  unknown: 'غير متاح',
  sessions: 'الاتصالات',
  ready: 'جاهزة',
  enabled: 'مطلوب تفعيلها',
  paused: 'موقوفة يدويًا',
  unreviewed: 'مراجعات غير مؤكدة',
  operational: 'قراءة الموافقات',
  transport: 'قراءة الجلسات',
  healthyRead: 'استجابة سليمة',
  readUnavailable: 'الاستجابة غير متاحة',
  readUnauthorized: 'يلزم تسجيل الدخول',
  readForbidden: 'لا توجد صلاحية',
  readInvalid: 'بيانات غير مكتملة',
  release: 'بوابة النشر الإنتاجي',
  configured: 'مهيأة خادميًا',
  closed: 'غير مفعّلة',
  testMode: 'وضع TEST — لا يثبت الإذن الإنتاجي',
  gate: 'نمط بوابة W07',
  discrepancy: 'تباين في عدد الاتصالات بين واجهتي القراءة؛ صعّد للتحقق.',
  reasons: 'ملخص أسباب المنع',
  suggested: 'إجراءات مقترحة للمراجعة البشرية',
  recommendations: 'مجرد اقتراحات، وليست تشخيصًا قاطعًا أو إذنًا بالإرسال.',
  clipboard: 'نسخ تقرير دعم منقح',
  copied: 'نُسخ تقرير الدعم المنقح. سلّمه يدويًا عبر قناة دعم داخلية معتمدة.',
  copyFailed: 'تعذر النسخ. تحقق من صلاحيات الحافظة في المتصفح.',
  privacyTitle: 'ما الذي يحتويه التقرير؟',
  privacyDesc: 'حالات عامة، أعداد، أكواد منع معتمدة، ووقت الفحص فقط. لا يتم إرسال التقرير إلى أي خدمة، ولا يتضمن معرفات الحساب/الجلسة أو جهات الاتصال أو بيانات الاعتماد أو سجلات خامًا.',
  noGuarantee: 'لا يعني فحص HTTP ناجحًا أن المزوّد متصل فعليًا أو أن رسالة تم تسليمها.',
  escalateNote: 'التصعيد يتم يدويًا باستخدام مرجع حادث داخلي. هذا المركز لا ينشئ تذكرة خارجية ولا يرسل بيانات الدعم تلقائيًا.',
  reference: 'دليل هندسي وإجراءات الدعم',
  workOwner: 'تحديد مالك الحالة ومستوى الخطورة قبل الإجراء',
  recovery: 'لا تُستأنف العمال أو الإرسال بعد الحوادث إلا بدليل حالة ومراجعة مستقلة.',
}
const enCopy: typeof arCopy = {
  title: 'Help & operations center',
  subtitle: 'An operator guide for incident diagnosis, safe recovery, escalation and read-only state checks—without sends or credential exposure.',
  incidentTab: 'Troubleshooting',
  guidanceOnly: 'Guidance only · no sends',
  guideTab: 'Operating procedures',
  diagnosticTab: 'Safe diagnostics',
  faqTab: 'FAQ',
  search: 'Search symptoms or codes like ACK, 503 or QR',
  allTopics: 'All topics',
  cases: 'Documented support scenarios',
  findCase: 'Select the observed problem',
  incidentEmpty: 'No matching incidents. Try another search or clear the filter.',
  severity: 'Priority',
  owner: 'Responsible role',
  symptom: 'Observed symptoms',
  procedure: 'Safe steps',
  avoid: 'Never do',
  escalate: 'When and where to escalate',
  stepsDone: 'Reviewed steps',
  resetSteps: 'Reset checklist',
  openSection: 'Open relevant settings',
  noAccess: 'You can read the guides; operational controls and diagnostics require owner/admin access.',
  noAutomaticAction: 'This checklist is guidance only; checking a step does not change the database, stop a worker or send a message.',
  guideIntro: 'Step-by-step runbooks. Perform sensitive actions only in their approved management screen, with appropriate authorization.',
  faqIntro: 'Practical answers on providers, privacy, consent, reconciliation and TEST restrictions.',
  auditSafe: 'Tenant isolation and data privacy',
  auditSafeDesc: 'Never attach API keys, QR, HMAC, JIDs, phone numbers or message bodies to support tickets. For possible leaks or cross-tenant exposure follow the P0 procedures.',
  diagnosticsTitle: 'Read-only diagnostic snapshot',
  diagnosticsDesc: 'Only on click, queries existing WACRM consent and session APIs. It does not contact the OpenWA gateway, initiate a send or retry messages.',
  runCheck: 'Check current state',
  checking: 'Reading state',
  diagUnrun: 'No diagnostic was run yet; no connection or consent state can be inferred.',
  diagOnlyAdmin: 'This check requires owner/admin permissions; no account data is fetched without authorization.',
  diagPartial: 'Partial or unverifiable results. Unavailable data is not a healthy or empty state.',
  diagComplete: 'Read-only check completed; this is not live send testing or proof of delivery.',
  checkedAt: 'Checked at',
  policy: 'OpenWA policy',
  consent: 'Account consent',
  approved: 'Approved in database',
  notApproved: 'Not approved',
  current: 'Current',
  notCurrent: 'Not current',
  unknown: 'Unavailable',
  sessions: 'Connections',
  ready: 'Ready',
  enabled: 'Activation requested',
  paused: 'Manually paused',
  unreviewed: 'Unreviewed sends',
  operational: 'Consent read',
  transport: 'Session read',
  healthyRead: 'Verified response',
  readUnavailable: 'Unavailable response',
  readUnauthorized: 'Sign-in required',
  readForbidden: 'Insufficient permissions',
  readInvalid: 'Incomplete data',
  release: 'Production release gate',
  configured: 'Server-side configured',
  closed: 'Off',
  testMode: 'TEST mode—not production authorization',
  gate: 'W07 gate mode',
  discrepancy: 'Connection counts differ between read endpoints; escalate for review.',
  reasons: 'Denial reason summary',
  suggested: 'Procedures for manual review',
  recommendations: 'Suggested next steps only—not definitive diagnosis or permission to send.',
  clipboard: 'Copy sanitized handoff',
  copied: 'Sanitized handoff copied. Share it manually through an approved internal support channel.',
  copyFailed: 'Copy failed. Check clipboard permissions.',
  privacyTitle: 'What the handoff contains',
  privacyDesc: 'Only coarse status, counts, known denial codes and check time. Nothing is sent anywhere, and no account/session IDs, recipients, keys or raw logs are included.',
  noGuarantee: 'A successful HTTP read does not prove provider connectivity or message delivery.',
  escalateNote: 'Escalation is manual through an internal incident reference. This UI does not create external tickets or automatically transmit support information.',
  reference: 'Support engineering runbook',
  workOwner: 'Determine severity and incident owner before any operator action',
  recovery: 'Never resume workers/sends after an incident without independent verified state and review.',
}
type UIState = { snapshot: SafeSupportSnapshot; checkedAt: Date; accountScope: string }

function sourceFromResponse(status: number, value: unknown, contentType: string): SupportSource {
  if (status === 401) return { status: 'unauthorized' }
  if (status === 403) return { status: 'forbidden' }
  if (status < 200 || status > 299) return { status: 'unavailable' }
  if (!contentType.toLowerCase().includes('application/json')) return { status: 'invalid' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' }
  return { status: 'ok', data: value }
}

async function readOnlyStatus(url: string, signal: AbortSignal): Promise<SupportSource> {
  try {
    const response = await fetch(url, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { accept: 'application/json' },
    })
    const type = response.headers.get('content-type') || ''
    if (!response.ok || !type.toLowerCase().includes('application/json')) {
      return sourceFromResponse(response.status, null, type)
    }
    const parsed: unknown = await response.json()
    return sourceFromResponse(response.status, parsed, type)
  } catch {
    // No raw network/Next.js error text reaches the UI or copied evidence.
    return { status: 'unavailable' }
  }
}
function severityVariant(severity: SupportSeverity): 'destructive' | 'secondary' | 'outline' {
  return severity === 'p0' || severity === 'p1' ? 'destructive'
    : severity === 'p2' ? 'secondary' : 'outline'
}

/** User-facing support operations; does NOT own a support ticket backend. */
export function OpenWASupportCenter({
  onNavigate,
}: { onNavigate: (tab: SupportDestination) => void }) {
  const locale = useLocale()
  const ar = locale.startsWith('ar')
  const copy = ar ? arCopy : enCopy
  const { accountId, canEditSettings } = useAuth()
  const [view, setView] = useState<SupportView>('incidents')
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<SupportTopic | 'all'>('all')
  const [selectedId, setSelectedId] = useState(OPENWA_SUPPORT_PROCEDURES[0]?.id ?? '')
  const [checkedSteps, setCheckedSteps] = useState<Record<number, boolean>>({})
  const [result, setResult] = useState<UIState | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  // Prevent a one-frame stale aggregate leak across account/permission
  // changes before React runs effect cleanup.
  const visibleResult = result?.accountScope === (accountId || '') + ':' + canEditSettings
    ? result : null
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)

  // Read-only diagnostic data never persists across account/role switch.
  useEffect(() => {
    setResult(null)
    setDiagnosing(false)
    return () => {
      sequence.current += 1
      controller.current?.abort()
      controller.current = null
    }
  }, [accountId, canEditSettings])

  const procedures = useMemo(
    () => searchOpenWASupport(locale, query, topic), [locale, query, topic],
  )
  const selected = procedures.find(item => item.id === selectedId) ?? procedures[0] ?? null
  const completedCount = selected
    ? selected.steps.reduce((sum, _, index) => sum + (selected.id === selectedId && checkedSteps[index] ? 1 : 0), 0)
    : 0

  function chooseProcedure(id: string) {
    setSelectedId(id)
    setCheckedSteps({})
  }

  async function checkStatus() {
    if (!canEditSettings || !accountId || diagnosing) return
    const req = ++sequence.current
    const aborter = new AbortController()
    controller.current?.abort()
    controller.current = aborter
    setDiagnosing(true)
    setResult(null)
    // Bounded read-only diagnostic; abort never causes a write or resend.
    const deadline = setTimeout(() => aborter.abort(), 12000)
    try {
      const [operational, sessions] = await Promise.all([
        readOnlyStatus('/api/whatsapp/connections/openwa/operational-policy', aborter.signal),
        readOnlyStatus('/api/whatsapp/connections/openwa', aborter.signal),
      ])
      if (sequence.current !== req) return
      setResult({
        snapshot: deriveOpenWASupportSnapshot(operational, sessions),
        checkedAt: new Date(),
        accountScope: accountId + ':' + canEditSettings,
      })
    } finally {
      clearTimeout(deadline)
      if (sequence.current === req) {
        setDiagnosing(false)
        controller.current = null
      }
    }
  }

  async function copyHandoff() {
    if (!visibleResult || !canEditSettings) return
    try {
      // Direct user click. ONLY allowlisted metadata from the derived snapshot.
      await navigator.clipboard.writeText(
        formatOpenWASupportHandoff(visibleResult.snapshot, visibleResult.checkedAt, locale),
      )
      toast.success(copy.copied)
    } catch {
      toast.error(copy.copyFailed)
    }
  }

  function openSuggested(id: string) {
    const p = findOpenWASupportProcedure(id)
    if (!p) return
    setQuery('')
    setTopic('all')
    chooseProcedure(p.id)
    setView('incidents')
  }
  function navigate(tab: SupportDestination) {
    if (!canEditSettings && tab !== 'meta') return
    onNavigate(tab)
  }
  function sourceLabel(status: SafeSupportSnapshot['operationalRead']): string {
    return status === 'ok' ? copy.healthyRead :
      status === 'unauthorized' ? copy.readUnauthorized :
      status === 'forbidden' ? copy.readForbidden :
      status === 'invalid' ? copy.readInvalid : copy.readUnavailable
  }
  function formatCount(value: number | null): string {
    return value === null ? '—' : new Intl.NumberFormat(locale).format(value)
  }

  return <section className="space-y-5" aria-labelledby="w07-support-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted/35 px-3 py-1 text-xs font-medium text-muted-foreground">
          <LifeBuoy className="size-3.5" aria-hidden="true" />W07-06 · {copy.title}
        </div>
        <h3 id="w07-support-title" className="text-xl font-semibold tracking-tight">{copy.title}</h3>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{copy.subtitle}</p>
      </div>
      <Badge variant="outline" className="gap-1.5 self-start">
        <ShieldCheck className="size-3.5" aria-hidden="true" />{copy.guidanceOnly}
      </Badge>
    </div>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{copy.workOwner}</p>
        </CardContent>
      </Card>
      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex items-start gap-3 p-4">
          <LockKeyhole className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{copy.auditSafe}</p>
        </CardContent>
      </Card>
      <Card className="border-border/70 shadow-xs">
        <CardContent className="flex items-start gap-3 p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{copy.recovery}</p>
        </CardContent>
      </Card>
    </div>

    <Tabs value={view} onValueChange={v => setView(v as SupportView)}>
      <div className="max-w-full overflow-x-auto border-b pb-1">
        <TabsList variant="line" className="h-12 min-w-max gap-1">
          <TabsTrigger value="incidents" className="min-h-10 px-3 sm:px-4">
            <Wrench className="me-1.5 size-4" aria-hidden="true" />{copy.incidentTab}
          </TabsTrigger>
          <TabsTrigger value="guides" className="min-h-10 px-3 sm:px-4">
            <ClipboardCheck className="me-1.5 size-4" aria-hidden="true" />{copy.guideTab}
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="min-h-10 px-3 sm:px-4">
            <RefreshCw className="me-1.5 size-4" aria-hidden="true" />{copy.diagnosticTab}
          </TabsTrigger>
          <TabsTrigger value="faq" className="min-h-10 px-3 sm:px-4">
            <CircleHelp className="me-1.5 size-4" aria-hidden="true" />{copy.faqTab}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="incidents" className="space-y-4 pt-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div className="space-y-1">
            <h4 className="font-semibold">{copy.findCase}</h4>
            <p className="text-sm text-muted-foreground">
              {OPENWA_SUPPORT_PROCEDURES.length} {copy.cases}
            </p>
          </div>
          <div className="relative w-full md:max-w-sm">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={e => { setQuery(e.target.value); setCheckedSteps({}) }}
              maxLength={120} className="ps-9" placeholder={copy.search}
              aria-label={copy.search} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={copy.allTopics}>
          <Button type="button" variant={topic === 'all' ? 'secondary' : 'outline'}
            size="sm" aria-pressed={topic === 'all'} onClick={() => { setTopic('all'); setCheckedSteps({}) }}>
            {copy.allTopics}
          </Button>
          {(Object.keys(OPENWA_SUPPORT_TOPICS) as SupportTopic[]).map(key =>
            <Button key={key} type="button" size="sm"
              aria-pressed={topic === key}
              variant={topic === key ? 'secondary' : 'outline'}
              onClick={() => { setTopic(key); setCheckedSteps({}) }}>
              {localizeSupport(OPENWA_SUPPORT_TOPICS[key], locale)}
            </Button>)}
        </div>
        {!selected ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {copy.incidentEmpty}
        </div> : <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.5fr)]">
          <div className="max-h-[630px] space-y-2 overflow-y-auto pe-1" role="group" aria-label={copy.findCase}>
            {procedures.map(item =>
              <button key={item.id} type="button"
                aria-pressed={selected.id === item.id}
                onClick={() => chooseProcedure(item.id)}
                className={'w-full rounded-xl border p-3 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
                  (selected.id === item.id
                    ? 'border-primary/50 bg-primary/5'
                    : 'bg-card hover:border-primary/35 hover:bg-muted/30')}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={severityVariant(item.severity)}>{item.severity.toUpperCase()}</Badge>
                  <span className="text-xs text-muted-foreground">{localizeSupport(OPENWA_SUPPORT_TOPICS[item.topic], locale)}</span>
                </span>
                <span className="mt-2 block text-sm font-semibold leading-6">{localizeSupport(item.title, locale)}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                  {localizeSupport(item.symptom, locale)}
                </span>
              </button>)}
          </div>
          <Card className="min-w-0 border-border/80 shadow-xs" key={selected.id}>
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant={severityVariant(selected.severity)}>
                  {selected.severity.toUpperCase()} · {localizeSupport(OPENWA_SUPPORT_SEVERITIES[selected.severity], locale)}
                </Badge>
                <Badge variant="outline">{copy.owner}: {localizeSupport(OPENWA_SUPPORT_ROLES[selected.owner], locale)}</Badge>
              </div>
              <CardTitle className="text-lg">{localizeSupport(selected.title, locale)}</CardTitle>
              <CardDescription className="leading-6">
                <strong className="font-medium text-foreground">{copy.symptom}: </strong>
                {localizeSupport(selected.symptom, locale)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h5 className="font-semibold">{copy.procedure}</h5>
                  <span className="text-xs text-muted-foreground">
                    {copy.stepsDone}: {completedCount}/{selected.steps.length}
                  </span>
                </div>
                <ol className="space-y-2">
                  {selected.steps.map((step, index) =>
                    <li key={index} className="flex items-start gap-3 rounded-lg border bg-background p-3">
                      <Checkbox id={'w07-step-' + selected.id + '-' + index}
                        checked={selected.id === selectedId && checkedSteps[index] === true}
                        onCheckedChange={checked => {
                          if (selected.id !== selectedId) {
                            setSelectedId(selected.id)
                            setCheckedSteps({ [index]: checked === true })
                          } else setCheckedSteps(prev => ({ ...prev, [index]: checked === true }))
                        }}
                        aria-label={localizeSupport(step, locale)} />
                      <label htmlFor={'w07-step-' + selected.id + '-' + index}
                        className="flex-1 cursor-pointer text-sm leading-6">
                        {localizeSupport(step, locale)}
                      </label>
                    </li>)}
                </ol>
                <Button type="button" size="sm" variant="ghost" onClick={() => setCheckedSteps({})}>
                  <RefreshCw className="me-2 size-3.5" aria-hidden="true" />{copy.resetSteps}
                </Button>
                <p className="text-xs leading-5 text-muted-foreground">{copy.noAutomaticAction}</p>
              </div>
              <Alert variant="destructive">
                <ShieldOff className="size-4" />
                <AlertTitle>{copy.avoid}</AlertTitle>
                <AlertDescription className="leading-6">{localizeSupport(selected.avoid, locale)}</AlertDescription>
              </Alert>
              <Alert>
                <HeartHandshake className="size-4" />
                <AlertTitle>{copy.escalate}</AlertTitle>
                <AlertDescription className="leading-6">{localizeSupport(selected.escalate, locale)}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" disabled={!canEditSettings && selected.destination !== 'meta'}
                onClick={() => navigate(selected.destination)}>
                <ArrowLeftRight className="me-2 size-4" aria-hidden="true" />{copy.openSection}
              </Button>
            </CardContent>
          </Card>
        </div>}
      </TabsContent>

      <TabsContent value="guides" className="space-y-4 pt-4">
        <p className="text-sm leading-6 text-muted-foreground">{copy.guideIntro}</p>
        <div className="grid items-start gap-3 md:grid-cols-2">
          {OPENWA_SUPPORT_GUIDES.map(guide =>
            <Card key={guide.id} className="min-w-0 border-border/70">
              <CardHeader>
                <Badge variant="outline" className="w-fit">
                  {localizeSupport(OPENWA_SUPPORT_TOPICS[guide.topic], locale)}
                </Badge>
                <CardTitle className="text-base">{localizeSupport(guide.title, locale)}</CardTitle>
                <CardDescription className="leading-6">{localizeSupport(guide.description, locale)}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <details className="group rounded-lg border bg-muted/20 p-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                    {copy.procedure}
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <ol className="mt-3 list-decimal space-y-2 ps-5 text-sm leading-6 text-muted-foreground">
                    {guide.steps.map((step,index) =>
                      <li key={index}>{localizeSupport(step,locale)}</li>)}
                  </ol>
                </details>
                <Button type="button" size="sm" variant="outline"
                  disabled={!canEditSettings && guide.destination !== 'meta'}
                  onClick={() => navigate(guide.destination)}>
                  <ExternalLink className="me-2 size-4" aria-hidden="true" />{copy.openSection}
                </Button>
              </CardContent>
            </Card>)}
        </div>
      </TabsContent>

      <TabsContent value="diagnostics" className="space-y-4 pt-4">
        <Card className="border-border/75">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-5 text-primary" aria-hidden="true" />{copy.diagnosticsTitle}
            </CardTitle>
            <CardDescription className="leading-6">{copy.diagnosticsDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <LockKeyhole className="size-4" />
              <AlertTitle>{copy.privacyTitle}</AlertTitle>
              <AlertDescription className="leading-6">{copy.privacyDesc}</AlertDescription>
            </Alert>
            <Button type="button" onClick={() => void checkStatus()}
              disabled={diagnosing || !canEditSettings || !accountId}>
              {diagnosing ? <Loader2 className="me-2 size-4 animate-spin" /> :
                <RefreshCw className="me-2 size-4" />}
              {diagnosing ? copy.checking : copy.runCheck}
            </Button>
            {!canEditSettings && <p className="text-sm text-muted-foreground">{copy.diagOnlyAdmin}</p>}
            {visibleResult === null ? <div aria-live="polite" className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
              {copy.diagUnrun}
            </div> : <div aria-live="polite" className="space-y-4">
              <div className="rounded-xl border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                {copy.checkedAt}: {visibleResult.checkedAt.toLocaleString(locale)} · {copy.noGuarantee}
              </div>
              {visibleResult.snapshot.operationalRead !== 'ok' || visibleResult.snapshot.sessionsRead !== 'ok'
                ? <Alert variant="destructive">
                  <AlertCircle className="size-4" /><AlertDescription>{copy.diagPartial}</AlertDescription>
                </Alert>
                : <Alert><CheckCircle2 className="size-4" /><AlertDescription>{copy.diagComplete}</AlertDescription></Alert>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{copy.operational}</p>
                  <p className="mt-1 font-semibold">{sourceLabel(visibleResult.snapshot.operationalRead)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{copy.policy}: {
                    visibleResult.snapshot.policyApproved === null ? copy.unknown
                    : visibleResult.snapshot.policyApproved ? copy.approved : copy.notApproved
                  }</p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{copy.consent}</p>
                  <p className="mt-1 font-semibold">
                    {visibleResult.snapshot.consentCurrent === null ? copy.unknown
                      : visibleResult.snapshot.consentCurrent ? copy.current : copy.notCurrent}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{visibleResult.snapshot.consentStatus}</p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{copy.transport}</p>
                  <p className="mt-1 font-semibold">{sourceLabel(visibleResult.snapshot.sessionsRead)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{copy.sessions}: {formatCount(visibleResult.snapshot.connectionCount)}</p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{copy.unreviewed}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(visibleResult.snapshot.uncertainCount)}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{copy.paused}: {formatCount(visibleResult.snapshot.pausedCount)}</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
                  <p className="font-semibold">{copy.sessions}</p>
                  <p>{copy.ready}: {formatCount(visibleResult.snapshot.readyCount)}</p>
                  <p>{copy.enabled}: {formatCount(visibleResult.snapshot.enabledRequestedCount)}</p>
                  <p>{copy.gate}: {visibleResult.snapshot.gateMode}</p>
                  {visibleResult.snapshot.gateMode === 'enforce_release' ?
                    <p>{copy.release}: {visibleResult.snapshot.releaseConfigured ? copy.configured : copy.closed}</p> :
                    <p className="text-muted-foreground">{copy.testMode}</p>}
                  {visibleResult.snapshot.countsConsistent === false && <Alert variant="destructive">
                    <AlertCircle className="size-4" /><AlertDescription>{copy.discrepancy}</AlertDescription>
                  </Alert>}
                </div>
                <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
                  <p className="font-semibold">{copy.reasons}</p>
                  {Object.entries(visibleResult.snapshot.blockingReasonCounts)
                    .filter(([, n]) => n > 0).map(([name,n]) =>
                      <div key={name} className="flex items-center justify-between gap-3">
                        <code className="min-w-0 break-all text-xs">{name}</code>
                        <Badge variant="outline">{n}</Badge>
                      </div>)}
                  {Object.values(visibleResult.snapshot.blockingReasonCounts).every(value => value === 0)
                    && <p className="text-sm text-muted-foreground">{copy.unknown}</p>}
                </div>
              </div>
              <div className="rounded-xl border bg-muted/20 p-4">
                <h5 className="font-semibold">{copy.suggested}</h5>
                <p className="mt-1 text-xs text-muted-foreground">{copy.recommendations}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {visibleResult.snapshot.suggestedProcedures.map(id => {
                    const item = findOpenWASupportProcedure(id)
                    return item ? <Button type="button" key={id} variant="outline" size="sm"
                      onClick={() => openSuggested(id)}>
                      {localizeSupport(item.title, locale)}
                    </Button> : null
                  })}
                </div>
              </div>
              <Button type="button" variant="outline" onClick={() => void copyHandoff()}>
                <ClipboardCopy className="me-2 size-4" aria-hidden="true" />{copy.clipboard}
              </Button>
            </div>}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="faq" className="space-y-4 pt-4">
        <p className="text-sm leading-6 text-muted-foreground">{copy.faqIntro}</p>
        <div className="divide-y rounded-xl border bg-card px-4 sm:px-6">
          {OPENWA_SUPPORT_FAQS.map(item =>
            <details key={item.id} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-medium leading-6 focus-visible:outline-2 focus-visible:outline-ring">
                <span>{localizeSupport(item.question, locale)}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="mt-2 max-w-3xl pb-1 text-sm leading-7 text-muted-foreground">{localizeSupport(item.answer, locale)}</p>
            </details>)}
        </div>
        <Alert>
          <ShieldAlert className="size-4" />
          <AlertTitle>{copy.auditSafe}</AlertTitle>
          <AlertDescription>{copy.auditSafeDesc}</AlertDescription>
        </Alert>
      </TabsContent>
    </Tabs>

    <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-start">
      <FileText className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm leading-6 text-muted-foreground">{copy.escalateNote}</p>
      <a href="https://github.com/e-proo/wacrm/blob/refactor/service-platform-v2/docs/operations/OW14_W07_06_OPENWA_SUPPORT_INCIDENT_OPERATIONS_RUNBOOK.md"
        target="_blank" rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1.5 self-start text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        <BookOpen className="size-4" aria-hidden="true" />{copy.reference}
      </a>
    </div>
  </section>
}
