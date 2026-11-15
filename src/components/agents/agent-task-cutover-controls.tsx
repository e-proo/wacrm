'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Mode = 'disabled' | 'pilot' | 'inconsistent'
interface Readiness {
  mode: Mode
  ready: boolean
  blockers: string[]
  runtime: { outboundTaskDeliveryEnabled: boolean; dailyMessageBudget: number | null }
  whatsappScope: {
    enabled: boolean
    dailyRunLimit: number | null
    dailyTargetLimit: number | null
    dailyMessageLimit: number | null
  }
  counts: {
    nonterminalTasks: number
    sendingMessages: number
    reconciliationMessages: number
  }
}
interface CutoverStatus { environment: 'TEST'; readiness: Readiness }

const blockerLabels: Record<string, string> = {
  RUNTIME_POLICY_MISSING: 'إعدادات تشغيل الوكلاء غير موجودة',
  KILL_SWITCH_ENABLED: 'مفتاح إيقاف الوكلاء مفعّل',
  MULTI_AGENT_DISABLED: 'تشغيل الوكلاء المتعددين معطّل',
  RECOVERY_WORKER_DISABLED: 'عامل الاستعادة معطّل',
  NATIVE_TOOLS_DISABLED: 'أدوات الوكيل الأصلية معطّلة',
  PROPOSAL_TOOLS_DISABLED: 'أدوات المقترحات معطّلة',
  ACCOUNT_DAILY_MESSAGE_BUDGET_NOT_PILOT_BOUNDED: 'ميزانية الرسائل اليومية غير محددة ضمن حدود Pilot',
  WHATSAPP_SCOPE_CONTROL_MISSING: 'حدود قناة واتساب غير موجودة',
  WHATSAPP_DAILY_RUN_LIMIT_NOT_PILOT_BOUNDED: 'حد التشغيل اليومي لواتساب غير آمن',
  WHATSAPP_DAILY_TARGET_LIMIT_NOT_PILOT_BOUNDED: 'حد المستهدفين اليومي لواتساب غير آمن',
  WHATSAPP_DAILY_MESSAGE_LIMIT_NOT_PILOT_BOUNDED: 'حد الرسائل اليومي لواتساب غير آمن',
  OUTBOUND_FLAG_CHANNEL_SCOPE_MISMATCH: 'حالة إرسال المهام لا تطابق حالة قناة واتساب',
  OUTBOUND_ENABLED_WITHOUT_WHATSAPP_SCOPE: 'إرسال المهام مفعّل دون سياسة قناة واتساب',
  ENABLED_AUTOMATIC_TRIGGERS_PRESENT: 'توجد مهام مجدولة تلقائية مفعّلة',
  NONTERMINAL_TRIGGER_FIRINGS_PRESENT: 'توجد أحداث تشغيل غير منتهية',
  NONTERMINAL_AGENT_TASKS_PRESENT: 'توجد مهام وكلاء لم تنتهِ بعد',
  OUTBOUND_TRANSPORT_IN_FLIGHT: 'هناك رسالة قيد الإرسال',
  OUTBOUND_RECONCILIATION_REQUIRED: 'هناك رسالة تحتاج التحقق من نتيجة الإرسال',
  WHATSAPP_CHANNEL_CIRCUIT_OPEN: 'دائرة حماية قناة واتساب مفتوحة',
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  let data: Record<string, unknown>
  try { data = JSON.parse(text) as Record<string, unknown> }
  catch { throw new Error(`استجابة غير صالحة من خادم WACRM (HTTP ${response.status})`) }
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
  }
  return data
}

export function AgentTaskCutoverControls({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<CutoverStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await jsonResponse(
        await fetch('/api/agent-tasks/cutover', { cache: 'no-store' }),
      ) as unknown as CutoverStatus)
    } catch (cause) {
      setStatus(null)
      setError(cause instanceof Error ? cause.message : 'تعذّر فحص بوابة المهام.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function change(mode: 'pilot' | 'disabled') {
    if (busy || !status) return
    if (mode === 'pilot' && (!status.readiness.ready || status.readiness.mode !== 'disabled')) return
    const confirmed = window.confirm(mode === 'pilot'
      ? 'تفعيل بوابة إرسال مهام الوكلاء على TEST فقط؟ قد تبدأ المهام المعتمدة بالإرسال عند تشغيل العامل. تأكد من موافقة الأرقام المستهدفة وحدود Pilot والجلسة المختارة.'
      : 'إيقاف بوابة مهام الوكلاء على TEST؟ سيُمنع الإرسال الجديد، لكن الرسائل التي بدأت بالفعل قد تحتاج تتبعًا أو مصالحة.')
    if (!confirmed) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/agent-tasks/cutover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          mode,
          confirmation: mode === 'pilot'
            ? 'ENABLE_TEST_AGENT_TASK_PILOT'
            : 'DISABLE_TEST_AGENT_TASK_PILOT',
        }),
      })
      const result = await jsonResponse(response) as unknown as CutoverStatus
      setStatus(result)
      setNotice(mode === 'pilot'
        ? 'فُعّلت بوابة Agent Task Pilot على TEST. لا يزال كل اتصال ومُستهدف خاضعًا لقيود الإرسال.'
        : 'أُوقفت بوابة إرسال Agent Task على TEST. راجع أي رسالة كانت قيد الإرسال.')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تغيير البوابة.')
      await load()
    } finally { setBusy(false) }
  }

  const s = status?.readiness
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">بوابة إرسال مهام الوكلاء — TEST فقط</CardTitle>
          <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => void load()}>
            <RefreshCw className="ms-2 h-4 w-4" /> فحص الجاهزية
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading ? <p>جارٍ فحص جاهزية بوابة الإرسال...</p> : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {s ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {s.mode === 'disabled'
                ? <ShieldCheck className="h-4 w-4" />
                : <ShieldAlert className="h-4 w-4" />}
              <strong>{s.mode === 'pilot' ? 'Pilot مفعّل' : s.mode === 'disabled' ? 'الإرسال معطّل' : 'حالة غير متطابقة — يلزم إيقاف'}</strong>
              <span>· فحص الجاهزية: {s.ready ? 'ناجح' : 'يوجد مانع'}</span>
            </div>
            <p className="text-muted-foreground">
              ميزانية الحساب: {s.runtime.dailyMessageBudget ?? 'غير محددة'} رسالة/يوم؛
              حد واتساب: {s.whatsappScope.dailyTargetLimit ?? '—'} مستهدفين و{s.whatsappScope.dailyMessageLimit ?? '—'} رسالة/يوم؛
              مهام مفتوحة: {s.counts.nonterminalTasks}؛ قيد الإرسال: {s.counts.sendingMessages}؛
              تحتاج مصالحة: {s.counts.reconciliationMessages}.
            </p>
            {s.blockers.length ? (
              <div className="rounded-md border p-3">
                <strong>موانع التشغيل:</strong>
                <ul className="mt-1 list-disc space-y-1 pr-5">
                  {s.blockers.map((item) => <li key={item}>{blockerLabels[item] ?? item}</li>)}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || loading || s.mode !== 'disabled' || !s.ready}
                onClick={() => void change('pilot')}>
                تفعيل Pilot على TEST
              </Button>
              <Button type="button" variant="destructive" disabled={busy || loading || s.mode === 'disabled'}
                onClick={() => void change('disabled')}>
                إيقاف إرسال Agent Task
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              هذا المفتاح يغيّر بوابة Agent Task وقيد قناة واتساب بشكل ذري، ولا يتجاوز
              Pause أو موافقات المستهدفين أو شروط Meta/OpenWA. لا يُلغي الرسائل التي أُرسلت بالفعل.
              لا يُفعّل الإرسال آليًا عند فتح الصفحة.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
