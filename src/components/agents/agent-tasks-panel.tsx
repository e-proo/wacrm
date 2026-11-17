'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, ShieldAlert, Send, Settings2, Square, Play, CheckCircle2, XCircle, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { AgentTaskMultiContactPicker } from './agent-task-contact-picker'
import { AgentTaskCutoverControls } from './agent-task-cutover-controls'

interface Connection {
  id: string
  name: string
  provider: 'meta_cloud' | 'openwa'
  status: string
  ready: boolean
  archived: boolean
}
interface Agent {
  id: string
  name: string
  slug: string
  status: string
  published: boolean
  coverageVersions: number[]
  maxManualTargets: number
}
interface CoverageRequest {
  id: string
  requested_amount: string | number
  currency: string
  status: string
}
interface Task {
  id: string
  agentId: string
  taskType: string
  version: number
  status: string
  connectionId: string | null
  selectedContactId: string | null
  selectedContactIds: string[]
  coverageRequestId: string | null
  maxTargets: number
  maxAttemptsPerTarget: number
  createdAt: string
  completedAt?: string | null
  manualClosureKind?: 'cancelled' | 'finished_incomplete' | 'finished_complete' | null
  manualClosedAt?: string | null
  manualClosureNote?: string | null
}
interface ResponseData {
  connections: Connection[]
  agents: Agent[]
  coverageRequests: CoverageRequest[]
  tasks: Task[]
  outboundDeliveryEnabled: boolean
  devTaskWorkerActive?: boolean
  taskWorkerEnabled?: boolean
}
interface WorkerStatus {
  enabled: boolean
  localRunnerAvailable: boolean
  tasks: { queued: number; running: number; paused: number; scheduled: number; validating: number }
  outbound: { queued: number; inFlight: number }
  scannedAt: string
  truncated: boolean
}
interface TaskRecipientProgress {
  contactId: string
  pilotApproval?: 'approved' | 'missing' | 'unverified' | null
  name: string | null
  phone: string | null
  targetStatus: string | null
  attemptCount: number
  skipReason: string | null
  failureCode: string | null
  outboundStatus: string | null
  provider: string | null
  errorCode: string | null
  denialReason?: string | null
  supplierStage?: string | null
  offeredAmount?: string | null
  commissionPerThousand?: string | null
  supplierDetails?: string | null
  changeRequestCode?: number | null
  changeRequestStatus?: string | null
}
interface TaskProgressResponse {
  taskStatus: string
  holdReason?: string | null
  recipients: TaskRecipientProgress[]
}
const terminalTaskStatuses = new Set(['completed','partially_completed','failed','cancelled'])
const taskStatusLabel: Record<string, string> = {
  draft: 'مسودة', validating: 'قيد التحقق', scheduled: 'مجدولة', queued: 'بانتظار التنفيذ',
  running: 'قيد التنفيذ', paused: 'متوقفة مؤقتًا', completed: 'مكتملة',
  partially_completed: 'مكتملة جزئيًا', failed: 'فشلت', cancelled: 'أُلغيت',
}
const closureLabel: Record<string, string> = {
  cancelled: 'أُلغيت بأمر المسؤول',
  finished_incomplete: 'أُنهيت يدويًا — غير مكتملة',
  finished_complete: 'أُنهيت مكتملة بعد التحقق من النتائج',
}
const controlErrorLabel: Record<string, string> = {
  in_flight_or_reconciliation: 'توجد عملية إرسال جارية أو تحتاج مطابقة؛ لا يمكن إغلاق المهمة حتى تستقر نتيجتها. الإلغاء لا يسترجع رسالة قد أُرسلت.',
  targets_not_completed: 'لا يمكن اعتبار المهمة مكتملة لأن بعض المستهدفين لم يكتملوا. استخدم «إنهاء غير مكتملة».',
  coverage_not_fulfilled: 'طلب التغطية لم يصل بعد إلى حالة fulfilled؛ لا يمكن توثيق المهمة كمكتملة.',
  already_terminal: 'المهمة مغلقة بالفعل ولا يمكن تغيير نتيجتها.',
  TASK_STATE_CHANGED_OR_NOT_FOUND: 'تغيّرت حالة المهمة أو لم تعد متاحة.',
}
const supplierStageLabel: Record<string, string> = {
  availability: 'تأكيد القدرة على التوفير',
  amount: 'جمع مبلغ التغطية المتاح',
  commission: 'تحديد عمولة المورد لكل ألف',
  details: 'جمع تفاصيل التغطية والتنفيذ',
  confirmation: 'بانتظار تأكيد المورد النهائي',
  submitting: 'جارٍ تسجيل عرض المورد لدى الإدارة',
  submitted: 'رُفع عرض المورد للمراجعة الإدارية',
  needs_human: 'يتطلب متابعة بشرية لإكمال الرفع',
  declined: 'رفض المورد توفير التغطية',
}
const changeApprovalLabel: Record<string, string> = {
  pending: 'بانتظار موافقة الإدارة',
  approved: 'وافقت الإدارة؛ بانتظار تنفيذ التسجيل',
  executed: 'اعتمدت الإدارة وأُنشئ عرض التغطية',
  rejected: 'رفضت الإدارة العرض',
  expired: 'انتهت صلاحية طلب الاعتماد',
  cancelled: 'أُلغي طلب الاعتماد',
  failed: 'تعذر تنفيذ الطلب الموافق عليه',
}
const targetStatusLabel: Record<string, string> = {
  candidate: 'مرشح', eligible: 'مؤهل', queued: 'في الانتظار',
  preparing: 'قيد التحضير', sending: 'قيد الإرسال',
  contacted: 'تم التواصل', awaiting_reply: 'بانتظار الرد',
  replied: 'تم الرد', in_progress: 'قيد المعالجة',
  completed: 'اكتمل', skipped: 'تم التجاوز',
  failed: 'تعثر', paused_for_human: 'بانتظار مراجعة بشرية',
}
const taskHoldLabel: Record<string, string> = {
  connection_not_ready: 'جلسة واتساب المختارة غير جاهزة؛ تحقق من الاتصال.',
  connection_paused: 'إرسال هذه الجلسة موقوف. لن يبدأ العامل حتى تستأنفه بصلاحية المسؤول.',
  connection_circuit_open: 'الحماية أوقفت الإرسال مؤقتًا بسبب مشكلة في الاتصال.',
  pilot_guardrail_missing: 'إعدادات OpenWA Pilot لهذه الجلسة غير مكتملة.',
  pilot_recipient_not_verified: 'تعذّر مطابقة رقم واحد أو أكثر مع هوية OpenWA الصحيحة على هذه الجلسة.',
  pilot_recipient_not_approved: 'بعض الأرقام المحددة لم تُعتمد بعد في OpenWA Agent Pilot، أو انتهت صلاحية الاعتماد. اعتمد جميع الأرقام المقصودة قبل التشغيل.',
}
const guardrailDenialLabel: Record<string, string> = {
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_FIRST_TOUCH_DAILY_CAP: 'وصل حد أول تواصل اليومي؛ افتح إعدادات OpenWA وعدّل الحد أثناء توقف Pilot. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_HOURLY_CAP: 'وصل الحد الساعي العام للجلسة. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_DAILY_CAP: 'وصل الحد اليومي العام للجلسة. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_PILOT_WORKLOAD_HOURLY_CAP: 'وصل الحد الساعي لنوع الإرسال في Pilot. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_PILOT_WORKLOAD_DAILY_CAP: 'وصل الحد اليومي لنوع الإرسال في Pilot. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_MANUAL_PAUSE: 'الجلسة موقوفة. لم تُرسل الرسالة.',
  OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_FAILURE_CIRCUIT_OPEN: 'دائرة الحماية أوقفت الإرسال. لم تُرسل الرسالة.',
}
const outboundStatusLabel: Record<string, string> = {
  reserved: 'محجوز', queued: 'بانتظار الإرسال',
  sending: 'قيد الإرسال', sent: 'أُرسل',
  failed: 'فشل', cancelled: 'أُلغي',
  needs_reconciliation: 'يلزم التحقق من نتيجة الإرسال',
}

async function loadResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`الخادم أعاد استجابة غير صالحة (HTTP ${response.status}). تحقق من خادم WACRM.`)
  }
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
  }
  return data as T
}

function connectionLabel(value: Connection) {
  const provider = value.provider === 'openwa' ? 'OpenWA' : 'Meta Cloud'
  return `${value.name} · ${provider} · ${value.status}${value.archived ? ' · مؤرشفة' : ''}`
}

/**
 * Task-level transport, not the Agent's global/provider-of-model settings.
 * One Task can use OpenWA and a different Task of the same Agent can use Meta.
 * No credentials or raw OpenWA engine settings ever enter this client.
 */
export function AgentTasksPanel() {
  const [data, setData] = useState<ResponseData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [agentId, setAgentId] = useState('')
  const [requestId, setRequestId] = useState('')
  const [selectedConnection, setSelectedConnection] = useState('')
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [contactEligible, setContactEligible] = useState<boolean | null>(null)
  const [maxAttempts, setMaxAttempts] = useState(1)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editConnection, setEditConnection] = useState('')
  const [editContactIds, setEditContactIds] = useState<string[]>([])
  const [editContactEligible, setEditContactEligible] = useState<boolean | null>(null)
  const [editAttempts, setEditAttempts] = useState(1)
  const [progressTaskId, setProgressTaskId] = useState<string | null>(null)
  const [progress, setProgress] = useState<TaskProgressResponse | null>(null)
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressError, setProgressError] = useState<string | null>(null)
  const progressRequest = useRef<AbortController | null>(null)
  const submissionRef = useRef<{ fingerprint: string; submissionId: string } | null>(null)
  const [tasksRefreshedAt, setTasksRefreshedAt] = useState<string | null>(null)
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<ResponseData | null> => {
    setLoading(true)
    setError(null)
    try {
      const json = await loadResponse<ResponseData>(
        await fetch('/api/agent-tasks', { cache: 'no-store' }),
      )
      setData(json)
      return json
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تحميل المهام والاتصالات.')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const scanWorker = useCallback(async () => {
    setWorkerBusy(true)
    setWorkerError(null)
    try {
      const snapshot = await loadResponse<WorkerStatus>(
        await fetch('/api/agent-tasks/worker', { cache: 'no-store' }),
      )
      setWorkerStatus(snapshot)
    } catch (cause) {
      setWorkerError(cause instanceof Error ? cause.message : 'تعذّر فحص العامل.')
    } finally { setWorkerBusy(false) }
  }, [])
  useEffect(() => { void scanWorker() }, [scanWorker])

  async function toggleWorker() {
    if (!workerStatus || workerBusy) return
    const action = workerStatus.enabled ? 'stop' : 'start'
    if (!window.confirm(action === 'stop'
      ? 'إيقاف التقاط أعمال جديدة لهذا الحساب؟ لا يمكن التراجع عن رسائل بدأ إرسالها بالفعل.'
      : 'تشغيل العامل لهذا الحساب؟ قد يبدأ تنفيذ المهام المعلّقة وإرسال رسائل الموافَق عليها فورًا.')) return
    setWorkerBusy(true)
    setWorkerError(null)
    try {
      const snapshot = await loadResponse<WorkerStatus>(await fetch('/api/agent-tasks/worker', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }))
      setWorkerStatus(snapshot)
      setSuccess(action === 'stop' ? 'تم إيقاف بدء مهام جديدة لهذا الحساب.' : 'تم السماح للعامل بالعمل لهذا الحساب.')
      await reload()
    } catch (cause) {
      setWorkerError(cause instanceof Error ? cause.message : 'تعذّر التحكم في العامل.')
    } finally { setWorkerBusy(false) }
  }

  async function controlTask(task: Task,
    action: 'pause' | 'resume' | 'cancel' | 'finish_incomplete' | 'finish_complete') {
    if (busy || terminalTaskStatuses.has(task.status)) return
    const prompts: Record<typeof action,string> = {
      pause: 'إيقاف هذه المهمة مؤقتًا؟ قد تكتمل عملية إرسال بدأت بالفعل.',
      resume: 'استئناف المهمة؟ سيتمكن العامل من تنفيذ الأعمال المتبقية.',
      cancel: 'إلغاء هذه المهمة نهائيًا؟ سيُلغى العمل غير المرسل، ولن يمكن استئنافها.',
      finish_incomplete: 'إنهاء هذه المهمة الآن بوصفها غير مكتملة؟ ستُحفظ نتائجها الفعلية دون ادعاء النجاح.',
      finish_complete: 'إنهاء هذه المهمة بوصفها مكتملة؟ لن يُسمح بذلك إلا إذا كانت جميع النتائج وطلب التغطية مكتملين.',
    }
    if (!window.confirm(prompts[action])) return
    let note: string | null = null
    if (['cancel','finish_incomplete','finish_complete'].includes(action)) {
      const entered = window.prompt('ملاحظة الإغلاق (اختيارية، حتى 500 حرف):', '')
      if (entered === null) return
      note = entered.slice(0, 500)
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await loadResponse<{ updated: boolean; status: string }>(
        await fetch('/api/agent-tasks/' + encodeURIComponent(task.id) + '/control', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, note }),
        }),
      )
      setSuccess('تم تحديث المهمة: ' + (taskStatusLabel[result.status] ?? result.status))
      setEditingId(null)
      await reload()
      if (progressTaskId === task.id) await toggleProgress(task.id, true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'تعذّر تغيير حالة المهمة.'
      setError(controlErrorLabel[message] ?? message)
    } finally { setBusy(false) }
  }

  // Task status changes asynchronously through the TEST worker. Keep the
  // existing list current without disabling the form or reloading the page.
  const hasPendingTasks = Boolean(data?.tasks.some((task) =>
    ['queued', 'scheduled', 'running', 'validating'].includes(task.status)))
  useEffect(() => {
    if (!hasPendingTasks) return
    let refreshing = false
    const interval = setInterval(async () => {
      if (refreshing || busy || document.visibilityState !== 'visible') return
      refreshing = true
      try {
        const next = await loadResponse<ResponseData>(
          await fetch('/api/agent-tasks', { cache: 'no-store' }),
        )
        setData(next)
      } catch (error) {
        // Manual refresh continues to display detailed errors. Avoid
        // clearing form input or spamming toasts during background polling.
        console.warn('[Agent Tasks] background status refresh failed', error)
      } finally {
        refreshing = false
      }
    }, 15_000)
    return () => clearInterval(interval)
  }, [hasPendingTasks, busy])

  const connections = data?.connections ?? []
  const available = connections.filter((c) => c.ready && !c.archived)
  const currentReady = selectedConnection === 'latest' ||
    available.some((c) => c.id === selectedConnection)
  const selectedProvider = connections.find((c) => c.id === selectedConnection)?.provider
  const selectedAgent = data?.agents.find((agent) => agent.id === agentId)
  const agentCanUseCoverage = Boolean(selectedAgent?.coverageVersions.length)
  const agentCanUseOpenWA = selectedAgent?.coverageVersions.includes(2) === true
  const maxManualContacts = Math.max(1, Math.min(20, selectedAgent?.maxManualTargets ?? 1))

  const canCreate = !busy && data?.outboundDeliveryEnabled === true &&
    Boolean(agentId) && Boolean(requestId) && Boolean(selectedConnection) &&
    currentReady && agentCanUseCoverage &&
    selectedContactIds.length > 0 &&
    selectedContactIds.length <= maxManualContacts && contactEligible === true &&
    (selectedProvider !== 'openwa' || agentCanUseOpenWA)

  async function createTask() {
    if (!canCreate) return
    if (!window.confirm(
      `سيتم إنشاء مهمة لـ ${selectedContactIds.length} جهة اتصال. عند تشغيل العامل قد تُرسل رسالة WhatsApp لكل جهة مؤهلة. هل تأكدت من موافقة الجميع وحدود الإرسال؟`,
    )) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const payload = {
        agentId, coverageRequestId: requestId,
        whatsappConnectionId: selectedConnection === 'latest' ? null : selectedConnection,
        selectedContactIds,
        maxTargets: selectedContactIds.length, maxAttemptsPerTarget: maxAttempts,
      }
      // Preserve the same submission ID on uncertain network retries.
      // A new form submission after success gets a NEW ID, so an older
      // cancelled/completed Task cannot silently swallow the new task.
      const fingerprint = JSON.stringify(payload)
      if (!submissionRef.current || submissionRef.current.fingerprint !== fingerprint) {
        submissionRef.current = { fingerprint, submissionId: crypto.randomUUID() }
      }
      const json = await loadResponse<{ taskId: string; created: boolean }>(
        await fetch('/api/agent-tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...payload, submissionId: submissionRef.current.submissionId,
          }),
        }),
      )
      const latest = await reload()
      if (latest && latest.tasks.some(task => task.id === json.taskId)) {
        setSuccess(json.created
          ? `أُنشئت المهمة ${json.taskId.slice(0, 8)} وظهرت ضمن المهام الحالية.`
          : `المهمة ${json.taskId.slice(0, 8)} موجودة مسبقًا؛ لم يُنشأ تكرار.`)
        submissionRef.current = null
      } else if (latest) {
        setError(`أعاد الخادم معرّف المهمة ${json.taskId} لكنها لا تظهر في قائمة الحساب الحالي. تحقق من بيئة TEST والحساب، ثم اضغط تحديث المهام.`)
      } else {
        setError(`تمت معالجة طلب المهمة ${json.taskId} لكن تعذّر تأكيد ظهورها في القائمة. استخدم تحديث المهام أو أعد المحاولة بنفس الإعدادات؛ لن يُنشأ تكرار بسبب خطأ الشبكة.`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر إنشاء المهمة.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshCurrentTasks() {
    const latest = await reload()
    if (latest) {
      setTasksRefreshedAt(new Date().toLocaleTimeString('ar', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }))
      if (progressTaskId) await toggleProgress(progressTaskId, true)
    }
  }

  function beginEdit(task: Task) {
    setEditingId(task.id)
    setEditConnection(task.connectionId ?? 'latest')
    setEditContactIds(task.selectedContactIds.length
       ? task.selectedContactIds
       : task.selectedContactId ? [task.selectedContactId] : [])
    setEditContactEligible(null)
    setEditAttempts(task.maxAttemptsPerTarget)
    setError(null)
    setSuccess(null)
  }

  async function toggleProgress(taskId: string, refresh = false) {
    progressRequest.current?.abort()
    if (progressTaskId === taskId && !refresh) {
      setProgressTaskId(null)
      setProgress(null)
      return
    }
    const controller = new AbortController()
    progressRequest.current = controller
    setProgressTaskId(taskId)
    setProgress(null)
    setProgressError(null)
    setProgressLoading(true)
    try {
      const next = await loadResponse<TaskProgressResponse>(await fetch(
        '/api/agent-tasks/' + encodeURIComponent(taskId) + '/progress',
        { cache: 'no-store', signal: controller.signal },
      ))
      if (!controller.signal.aborted) setProgress(next)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setProgressError(cause instanceof Error ? cause.message : 'تعذّر تحميل حالة الأرقام.')
      }
    } finally {
      if (!controller.signal.aborted) setProgressLoading(false)
    }
  }

  async function saveEdit() {
    if (!editingId || !editConnection || busy ||
        editContactIds.length < 1 || editContactIds.length > (data?.tasks.find(t => t.id === editingId)?.maxTargets ?? 0) ||
         editContactEligible !== true) return
    if (editConnection !== 'latest' &&
        !available.some((connection) => connection.id === editConnection)) {
      setError('الجلسة المختارة غير جاهزة أو مؤرشفة.')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await loadResponse<{ ok: boolean }>(
        await fetch('/api/agent-tasks', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskId: editingId,
            whatsappConnectionId: editConnection === 'latest' ? null : editConnection,
            selectedContactIds: editContactIds,
            maxTargets: editContactIds.length,
            maxAttemptsPerTarget: editAttempts,
          }),
        }),
      )
      setSuccess('حُفظت إعدادات المهمة المعلقة. الجلسات المستخدمة في الرسائل المحجوزة لا تتغير.')
      setEditingId(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تعديل المهمة.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">مهام الوكلاء — اتصال WhatsApp لكل مهمة</h2>
          <p className="text-sm text-muted-foreground">
            اختر اتصالًا محددًا لمهمة Coverage. يمكنك استخدام جلسات Meta أو OpenWA
            مختلفة للوكيل نفسه، مع الحفاظ على الربط الثابت لكل رسالة.
          </p>
        </div>
        <Button type="button" variant="outline" disabled={loading || busy} onClick={() => void reload()}>
          <RefreshCw className="ms-2 h-4 w-4" /> تحديث الاتصالات
        </Button>
      </div>

      {error ? <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">{error}</p> : null}
      {success ? <p role="status" className="rounded-md border p-3 text-sm">{success}</p> : null}

      <AgentTaskCutoverControls onChanged={async () => { await reload() }} />

      <Card>
        <CardHeader><CardTitle className="text-base">إنشاء مهمة Coverage</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {loading ? <p className="text-sm text-muted-foreground">جارٍ تحميل البيانات...</p> : null}
          {data && !data.outboundDeliveryEnabled ? (
            <p className="flex items-start gap-2 rounded-md border p-3 text-sm text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              بوابة إرسال Agent Task معطّلة حاليًا في TEST. سيبقى إنشاء المهام الحية
              موقوفًا حتى اكتمال اختبارات الأمان والموافقة على Pilot.
            </p>
          ) : null}
          {data && !available.some((x) => x.provider === 'openwa') ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              لا توجد جلسة OpenWA جاهزة وغير مؤرشفة. تظهر الجلسات الجديدة بعد تسجيلها
              وإعادة تحميل القائمة؛ لن يتم استخدام Meta بدل OpenWA دون اختيارك.
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">الوكيل المنشور</span>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3" disabled={loading || busy}>
                <option value="">— اختر وكيلًا —</option>
                {(data?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id} disabled={agent.status !== 'active' || !agent.published || !agent.coverageVersions.length}>
                    {agent.name} · {agent.status}{!agent.published ? ' · دون نسخة منشورة' : ''}{!agent.coverageVersions.length ? ' · لم تُنشَر مهمة Coverage' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">طلب Coverage المصدر</span>
              <select value={requestId} onChange={(e) => { setRequestId(e.target.value); setSelectedContactIds([]); setContactEligible(null) }}
                className="h-10 w-full rounded-md border bg-background px-3" disabled={loading || busy}>
                <option value="">— اختر طلب تغطية —</option>
                {(data?.coverageRequests ?? []).map((req) => (
                  <option key={req.id} value={req.id}>
                    {req.id.slice(0, 8)} · {req.requested_amount} {req.currency} · {req.status}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">جلسة WhatsApp لهذه المهمة</span>
            <select value={selectedConnection} onChange={(e) => setSelectedConnection(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3" disabled={loading || busy}>
              <option value="">— اختر اتصالًا صراحةً —</option>
              <option value="latest">استخدم اتصال أحدث رسالة واردة من المستهدف (دون انتقال تلقائي)</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id} disabled={!connection.ready || connection.archived}>
                  {connectionLabel(connection)}{connection.ready ? '' : ' · غير متاحة'}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              لا تُرسل أي رسالة عبر اتصال آخر إذا توقفت هذه الجلسة. تتطلب OpenWA
              سياسة Coverage V2 ونافذة محادثة واردة صالحة.
            </span>
          </label>
          <AgentTaskMultiContactPicker
            selectedContactIds={selectedContactIds}
            onChange={setSelectedContactIds}
            maxSelected={maxManualContacts}
            coverageRequestId={requestId}
            allowPhoneRegistration={selectedProvider === 'openwa' && selectedConnection !== 'latest'}
            whatsappConnectionId={selectedConnection === 'latest' ? null : selectedConnection}
            disabled={loading || busy}
            onEligibilityChange={setContactEligible}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">عدد الأرقام المختارة</span>
              <Input type="number" min={1} max={maxManualContacts} value={selectedContactIds.length} readOnly disabled />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">أقصى محاولات لكل مستهدف</span>
              <Input type="number" min={1} max={20} value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                disabled={busy} />
            </label>
          </div>
          {selectedProvider === 'openwa' && !agentCanUseOpenWA && selectedAgent ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              هذا الوكيل لا يملك Coverage sourcing V2 في نسخته المنشورة. انشر نسخة Builder تتضمن V2 أولًا.
            </p>
          ) : null}
          {selectedProvider === 'openwa' ? (
            <p className="text-xs text-muted-foreground">
              في TEST يقبل OpenWA إما محادثة واردة حديثة، أو موافقة صريحة على رسائل واتساب
              موثّقة من مكالمة هاتفية لكل مستهدف. يجب اعتماد الأرقام المختارة في Pilot،
              مع الالتزام بالحظر وإلغاء الاشتراك والحدود والإيقاف.
            </p>
          ) : null}
          <Button type="button" onClick={() => void createTask()} disabled={!canCreate}>
            <Send className="ms-2 h-4 w-4" /> إنشاء المهمة
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">عامل المهام — تحكم TEST وفحص قائمة الانتظار</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            إيقاف العامل يمنع التقاط أعمال جديدة لهذا الحساب، ولا يوقف جلسة واتساب أو يلغي رسالة
            بدأ المزوّد إرسالها. الإرسال غير المؤكد يتطلب مطابقة.
          </p>
          {workerError && <p role="alert" className="text-sm text-destructive">{workerError}</p>}
          {workerStatus ? (
            <div className="space-y-2">
              <p role="status" className="text-sm font-medium">
                حالة الحساب: {workerStatus.enabled ? 'مسموح بالتشغيل' : 'موقوف'} ·
                عامل npm run dev: {workerStatus.localRunnerAvailable ? 'متاح' : 'غير مفعّل محليًا'}
              </p>
              <p className="text-xs text-muted-foreground">
                انتظار: {workerStatus.tasks.queued} · تنفيذ: {workerStatus.tasks.running} ·
                توقف مؤقت: {workerStatus.tasks.paused} · جدولة: {workerStatus.tasks.scheduled} ·
                Outbound انتظار: {workerStatus.outbound.queued} · Outbound معالجة: {workerStatus.outbound.inFlight}
                {workerStatus.truncated ? ' · الفحص يعرض أول 1000 سجل فقط' : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                آخر فحص: {new Date(workerStatus.scannedAt).toLocaleTimeString('ar')}
                {!workerStatus.localRunnerAvailable && workerStatus.enabled
                  ? ' · التشغيل التلقائي يتطلب npm run dev مع WACRM_DEV_AGENT_TASK_WORKER=on.' : ''}
              </p>
            </div>
          ) : <p className="text-xs text-muted-foreground">جارٍ التحقق من حالة العامل...</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={workerStatus?.enabled ? 'destructive' : 'default'}
              disabled={workerBusy || !workerStatus} onClick={() => void toggleWorker()}>
              {workerStatus?.enabled ? <Square className="ms-2 h-4 w-4" /> : <Play className="ms-2 h-4 w-4" />}
              {workerStatus?.enabled ? 'إيقاف العامل' : 'تشغيل العامل'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={workerBusy}
              onClick={() => void scanWorker()}>
              <ScanSearch className="ms-2 h-4 w-4" />
              {workerBusy ? 'جارٍ الفحص...' : 'فحص المهام الآن'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            الفحص للقراءة فقط؛ لا يرسل رسائل ولا يشغّل دورة تنفيذ.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-base">المهام الحالية وتعديل الجلسة</CardTitle>
              <p className="text-xs text-muted-foreground">
                المعروضة: {data?.tasks.length ?? 0} مهمة
                {tasksRefreshedAt ? ` · آخر تحديث: ${tasksRefreshedAt}` : ''}
                {hasPendingTasks ? ' · تحديث تلقائي كل 15 ثانية' : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                حالة تنفيذ العامل: {workerStatus?.enabled === false ? 'موقوف من لوحة التحكم'
                  : data?.devTaskWorkerActive ? 'مهيأ على TEST' : 'التشغيل المحلي يحتاج تفعيل npm run dev'}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={loading || busy}
              onClick={() => void refreshCurrentTasks()} aria-label="تحديث المهام الحالية">
              <RefreshCw className={`ms-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'جارٍ التحديث...' : 'تحديث المهام'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {(data?.tasks ?? []).length === 0 && !loading ? (
            <p className="text-sm text-muted-foreground">لا توجد مهام Agent Task مسجلة حاليًا.</p>
          ) : null}
          {(data?.tasks ?? []).map((task) => {
            const conn = connections.find((c) => c.id === task.connectionId)
            const editable = task.status === 'queued' || task.status === 'scheduled'
            return (
              <div key={task.id} className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold">{task.taskType}@{task.version}</span>
                    <span className="mx-2 text-muted-foreground">·</span>
                    <span>{task.manualClosureKind
                        ? closureLabel[task.manualClosureKind] ?? taskStatusLabel[task.status] ?? task.status
                        : taskStatusLabel[task.status] ?? task.status}</span>
                    {task.manualClosedAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        أُغلقت: {new Date(task.manualClosedAt).toLocaleString('ar')}
                        {task.manualClosureNote ? ' · ملاحظة: ' + task.manualClosureNote : ''}
                      </p>
                    )}
                    {task.status === 'queued' && conn?.provider === 'openwa' ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        يبدأ التنفيذ تلقائيًا بعد تفعيل جلسة OpenWA واعتماد جميع أرقام الوكيل في Pilot.
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {task.id.slice(0, 8)} · {conn ? connectionLabel(conn) : (task.connectionId ? 'اتصال غير متاح' : 'اتصال أحدث وارد')}
                      {task.selectedContactIds.length > 0
                         ? ` · ${task.selectedContactIds.length} جهة محددة` : ' · استهداف تلقائي'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline"
                      onClick={() => void toggleProgress(task.id)}>
                      {progressTaskId === task.id ? 'إخفاء حالة الأرقام' : 'حالة كل رقم'}
                    </Button>
                    <Button type="button" size="sm" variant="outline"
                      disabled={!editable || busy} onClick={() => beginEdit(task)}>
                      <Settings2 className="ms-2 h-4 w-4" /> تعديل إعدادات المهمة
                    </Button>
                    {!terminalTaskStatuses.has(task.status) && (
                      <>
                        {task.status === 'paused' ? (
                          <Button type="button" size="sm" variant="outline" disabled={busy}
                            onClick={() => void controlTask(task, 'resume')}>
                            <Play className="ms-2 h-4 w-4" /> استئناف المهمة
                          </Button>
                        ) : ['queued','scheduled','running'].includes(task.status) ? (
                          <Button type="button" size="sm" variant="outline" disabled={busy}
                            onClick={() => void controlTask(task, 'pause')}>
                            <Square className="ms-2 h-4 w-4" /> إيقاف مؤقت
                          </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="outline" disabled={busy}
                          onClick={() => void controlTask(task, 'finish_incomplete')}>
                          إنهاء غير مكتملة
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={busy}
                          onClick={() => void controlTask(task, 'finish_complete')}>
                          <CheckCircle2 className="ms-2 h-4 w-4" /> إنهاء كمكتملة
                        </Button>
                        <Button type="button" size="sm" variant="destructive" disabled={busy}
                          onClick={() => void controlTask(task, 'cancel')}>
                          <XCircle className="ms-2 h-4 w-4" /> إلغاء المهمة
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {progressTaskId === task.id ? (
                  <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                    <p className="text-sm font-semibold">نتائج المستهدفين لهذا الطلب</p>
                    {progressLoading ? <p className="text-xs text-muted-foreground">جارٍ تحميل الحالة...</p> : null}
                    {progressError ? <p role="alert" className="text-xs text-destructive">{progressError}</p> : null}
                    {progress?.holdReason ? (
                      <p role="status" className="rounded-md border border-amber-400/50 p-2 text-sm text-amber-700 dark:text-amber-400">
                        العامل مؤجّل مؤقتًا: {taskHoldLabel[progress.holdReason] ?? progress.holdReason}
                      </p>
                    ) : null}
                    {!progressLoading && progress && progress.recipients.length === 0 ? (
                      <p className="text-xs text-muted-foreground">لا توجد أرقام محددة في هذه المهمة.</p>
                    ) : null}
                    {progress?.recipients.map((recipient, index) => (
                      <div key={recipient.contactId} className="space-y-1 rounded-md border bg-background p-2 text-xs">
                        <p className="font-medium">{index + 1}. {recipient.name || 'جهة اتصال'} · <bdi>{recipient.phone || recipient.contactId.slice(0, 8)}</bdi></p>
                        {recipient.pilotApproval && (
                          <p role="status" className={recipient.pilotApproval === 'approved'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'}>
                            اعتماد OpenWA Agent Pilot: {recipient.pilotApproval === 'approved'
                              ? 'معتمد لهذا الرقم'
                              : recipient.pilotApproval === 'missing'
                                ? 'غير معتمد — هذا الرقم يمنع تنفيذ المجموعة'
                                : 'تعذّر التحقق من هوية الرقم أو اعتماده'}
                          </p>
                        )}
                        <p>حالة المستهدف: {recipient.targetStatus
                          ? targetStatusLabel[recipient.targetStatus] || recipient.targetStatus
                          : 'لم يبدأ التنفيذ'}</p>
                        <p>الإرسال: {recipient.outboundStatus
                          ? outboundStatusLabel[recipient.outboundStatus] || recipient.outboundStatus
                          : 'لم تُحجز رسالة'} · المحاولات: {recipient.attemptCount}
                          {recipient.provider ? ' · ' + (recipient.provider === 'openwa' ? 'OpenWA' : 'Meta Cloud') : ''}</p>
                        {recipient.supplierStage && (
                          <div className="mt-2 space-y-1 rounded-md border p-2">
                            <p className="font-semibold">سير تفاوض التغطية: {supplierStageLabel[recipient.supplierStage] ?? recipient.supplierStage}</p>
                            {recipient.offeredAmount && <p>المبلغ المعروض: {recipient.offeredAmount} SAR</p>}
                            {recipient.commissionPerThousand !== null && recipient.commissionPerThousand !== undefined &&
                              <p>عمولة المورد: {recipient.commissionPerThousand} لكل 1000</p>}
                            {recipient.supplierDetails && <p className="break-words">تفاصيل المورد: {recipient.supplierDetails}</p>}
                            {recipient.changeRequestCode !== null && recipient.changeRequestCode !== undefined ? (
                              <p className="font-medium">
                                مقترح الإدارة CHG-{recipient.changeRequestCode} ·
                                {' '}{changeApprovalLabel[recipient.changeRequestStatus ?? ''] ?? recipient.changeRequestStatus}
                              </p>
                            ) : (
                              <p className="text-muted-foreground">
                                لم يُنشأ طلب اعتماد إداري بعد. يجب استكمال التفاصيل وتأكيد المورد النهائي أولًا.
                              </p>
                            )}
                          </div>
                        )}
                        {recipient.skipReason || recipient.failureCode || recipient.errorCode ? (
                          <p className="text-amber-700 dark:text-amber-400">
                            السبب: {recipient.denialReason
                               ? guardrailDenialLabel[recipient.denialReason] ?? 'رفض WACRM الإرسال قبل محاولة التوصيل.'
                               : recipient.errorCode || recipient.failureCode || recipient.skipReason}
                          </p>
                        ) : null}
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      إنشاء المهمة لا يعني وصول الرسالة لكل رقم. حالات الإرسال غير المؤكدة تتطلب مطابقة مع المزوّد دون إعادة إرسال تلقائي.
                    </p>
                    <Button size="sm" type="button" variant="outline" disabled={progressLoading}
                      onClick={() => void toggleProgress(task.id, true)}>
                      تحديث حالة الأرقام
                    </Button>
                  </div>
                ) : null}
                {editingId === task.id ? (
                  <div className="space-y-3 rounded-md bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">
                      لا يسمح النظام بالتعديل إذا بدأ اختيار المستهدفين أو توجد عمليات إرسال،
                      حتى لا تتغير الجلسة أثناء التنفيذ.
                    </p>
                    <label className="block space-y-1 text-sm">
                      <span className="font-medium">الاتصال الجديد للمهام غير المنفذة</span>
                      <select value={editConnection} onChange={(e) => setEditConnection(e.target.value)}
                        className="h-10 w-full rounded-md border bg-background px-3">
                        <option value="latest">اتصال أحدث رسالة واردة</option>
                        {connections.map((c) => (
                          <option key={c.id} value={c.id} disabled={!c.ready || c.archived || (c.provider === 'openwa' && task.taskType === 'coverage.sourcing' && task.version < 2)}>
                            {connectionLabel(c)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <AgentTaskMultiContactPicker
                       selectedContactIds={editContactIds}
                       onChange={setEditContactIds}
                       maxSelected={task.maxTargets}
                      coverageRequestId={task.coverageRequestId ?? ''}
                      onEligibilityChange={setEditContactEligible}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1 text-sm">
                        الحد الأقصى للمستهدفين
                        <Input type="number" min={1} max={task.maxTargets} value={editContactIds.length} readOnly disabled />
                      </label>
                      <label className="space-y-1 text-sm">
                        المحاولات لكل مستهدف
                        <Input type="number" min={1} max={task.maxAttemptsPerTarget} value={editAttempts}
                          onChange={(e) => setEditAttempts(Number(e.target.value))} />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy || editContactIds.length < 1 || editContactIds.length > task.maxTargets || editContactEligible !== true} onClick={() => void saveEdit()}>حفظ إعدادات المهمة</Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditingId(null)}>إلغاء</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
