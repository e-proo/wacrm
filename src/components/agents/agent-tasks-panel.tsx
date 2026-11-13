'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, Send, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

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
  maxTargets: number
  maxAttemptsPerTarget: number
  createdAt: string
}
interface ResponseData {
  connections: Connection[]
  agents: Agent[]
  coverageRequests: CoverageRequest[]
  tasks: Task[]
  outboundDeliveryEnabled: boolean
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
  const [maxTargets, setMaxTargets] = useState(1)
  const [maxAttempts, setMaxAttempts] = useState(1)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editConnection, setEditConnection] = useState('')
  const [editTargets, setEditTargets] = useState(1)
  const [editAttempts, setEditAttempts] = useState(1)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const json = await loadResponse<ResponseData>(
        await fetch('/api/agent-tasks', { cache: 'no-store' }),
      )
      setData(json)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تحميل المهام والاتصالات.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const connections = data?.connections ?? []
  const available = connections.filter((c) => c.ready && !c.archived)
  const currentReady = selectedConnection === 'latest' ||
    available.some((c) => c.id === selectedConnection)
  const selectedProvider = connections.find((c) => c.id === selectedConnection)?.provider

  const canCreate = !busy && data?.outboundDeliveryEnabled === true &&
    Boolean(agentId) && Boolean(requestId) && Boolean(selectedConnection) &&
    currentReady

  async function createTask() {
    if (!canCreate) return
    if (!window.confirm(
      'سيتم إنشاء مهمة مؤهلة للتنفيذ. إذا كانت بوابات التشغيل مفعّلة فقد يبدأ إرسال رسالة إلى جهة مؤهلة. هل تأكدت من إعداد الحدود والمستهدفين؟',
    )) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const json = await loadResponse<{ taskId: string; created: boolean }>(
        await fetch('/api/agent-tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentId, coverageRequestId: requestId,
            whatsappConnectionId: selectedConnection === 'latest' ? null : selectedConnection,
            maxTargets, maxAttemptsPerTarget: maxAttempts,
          }),
        }),
      )
      setSuccess(json.created
        ? `أُنشئت المهمة ${json.taskId.slice(0, 8)} على الاتصال المختار.`
        : 'توجد مهمة نشطة لهذا الطلب؛ لم نُنشئ نسخة مكررة.')
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر إنشاء المهمة.')
    } finally {
      setBusy(false)
    }
  }

  function beginEdit(task: Task) {
    setEditingId(task.id)
    setEditConnection(task.connectionId ?? 'latest')
    setEditTargets(task.maxTargets)
    setEditAttempts(task.maxAttemptsPerTarget)
    setError(null)
    setSuccess(null)
  }

  async function saveEdit() {
    if (!editingId || !editConnection || busy) return
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
            maxTargets: editTargets,
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
                  <option key={agent.id} value={agent.id} disabled={agent.status !== 'active' || !agent.published}>
                    {agent.name} · {agent.status}{!agent.published ? ' · دون نسخة منشورة' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">طلب Coverage المصدر</span>
              <select value={requestId} onChange={(e) => setRequestId(e.target.value)}
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
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">أقصى مستهدفين</span>
              <Input type="number" min={1} max={100} value={maxTargets}
                onChange={(e) => setMaxTargets(Number(e.target.value))}
                disabled={busy} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">أقصى محاولات لكل مستهدف</span>
              <Input type="number" min={1} max={20} value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                disabled={busy} />
            </label>
          </div>
          {selectedProvider === 'openwa' ? (
            <p className="text-xs text-muted-foreground">
              يتطلب إرسال OpenWA محادثة واردة حديثة من المستهدف على الجلسة نفسها،
              وعدم وجود حظر أو إلغاء اشتراك، والسماح بالرقم في ضوابط Pilot.
            </p>
          ) : null}
          <Button type="button" onClick={() => void createTask()} disabled={!canCreate}>
            <Send className="ms-2 h-4 w-4" /> إنشاء المهمة
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المهام الحالية وتعديل الجلسة</CardTitle></CardHeader>
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
                    <span>{task.status}</span>
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {task.id.slice(0, 8)} · {conn ? connectionLabel(conn) : (task.connectionId ? 'اتصال غير متاح' : 'اتصال أحدث وارد')}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline"
                    disabled={!editable || busy} onClick={() => beginEdit(task)}>
                    <Settings2 className="ms-2 h-4 w-4" /> تعديل إعدادات المهمة
                  </Button>
                </div>
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
                          <option key={c.id} value={c.id} disabled={!c.ready || c.archived}>
                            {connectionLabel(c)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1 text-sm">
                        الحد الأقصى للمستهدفين
                        <Input type="number" min={1} max={task.maxTargets} value={editTargets}
                          onChange={(e) => setEditTargets(Number(e.target.value))} />
                      </label>
                      <label className="space-y-1 text-sm">
                        المحاولات لكل مستهدف
                        <Input type="number" min={1} max={task.maxAttemptsPerTarget} value={editAttempts}
                          onChange={(e) => setEditAttempts(Number(e.target.value))} />
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void saveEdit()}>حفظ إعدادات المهمة</Button>
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
