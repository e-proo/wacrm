'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type Row = {
  id: string
  event_kind: 'unresolved_identity' | 'unmatched_status'
  state: 'pending' | 'leased' | 'completed' | 'review'
  attempt_count: number
  last_error_code: string | null
  created_at: string
}
type Summary = {
  counts: Record<string, number>
  sample: Row[]
  may_retry: boolean
}
export function OpenWAReconciliation({ connectionId }: { connectionId: string }) {
  const locale = useLocale()
  const ar = locale.startsWith('ar')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/reconciliation`

  async function refresh() {
    setLoading(true)
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      if (!res.ok) throw new Error('diagnostics_unavailable')
      const payload = await res.json() as Summary
      if (!payload || !Array.isArray(payload.sample)) throw new Error('invalid_response')
      setData(payload)
    } catch {
      toast.error(ar ? 'تعذر تحميل حالة الرسائل والإيصالات المؤجلة' : 'Unable to load deferred event diagnostics')
    } finally {
      setLoading(false)
    }
  }

  async function retry(jobId: string) {
    setRetrying(jobId)
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_review', job_id: jobId }),
      })
      if (!res.ok) throw new Error('retry_rejected')
      toast.success(ar ? 'أعيدت المهمة إلى قائمة المعالجة' : 'Deferred item queued for recheck')
      await refresh()
    } catch {
      toast.error(ar ? 'تعذر إعادة المحاولة. راجع حالة الاتصال' : 'Retry failed; check connection status')
    } finally { setRetrying(null) }
  }

  const pending = Object.entries(data?.counts ?? {}).reduce((n, [k, v]) =>
    n + (k.endsWith(':pending') || k.endsWith(':leased') ? v : 0), 0)
  const review = Object.entries(data?.counts ?? {}).reduce((n, [k, v]) =>
    n + (k.endsWith(':review') ? v : 0), 0)
  const outstanding = data?.sample.filter(item => item.state === 'pending' ||
    item.state === 'leased' || item.state === 'review') ?? []

  return <section className="space-y-3 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-sm font-semibold">{ar ? 'مراجعة هوية الرسائل وإيصالات التسليم' : 'Identity & delivery reconciliation'}</p>
        <p className="text-xs text-muted-foreground">
          {ar ? 'رسائل LID وإيصالات لم تكتمل مطابقتها، دون إعادة إرسال تلقائي' :
            'Unresolved LID messages and ACKs, with no automatic resend'}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={loading}
        onClick={() => { setOpen(!open); if (!open) void refresh() }}>
        <RefreshCw className="me-2 h-4 w-4" />
        {open ? (ar ? 'إخفاء' : 'Hide') : (ar ? 'عرض الحالة' : 'Show status')}
      </Button>
    </div>
    {open && <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{ar ? 'قيد المعالجة' : 'Pending'}: {pending}</Badge>
        <Badge variant={review > 0 ? 'destructive' : 'outline'}>
          {ar ? 'تحتاج مراجعة' : 'Needs review'}: {review}
        </Badge>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className="me-1 h-3 w-3" />{ar ? 'تحديث' : 'Refresh'}
        </Button>
      </div>
      {outstanding.length === 0
        ? <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            {ar ? 'لا توجد حالات عالقة ضمن أحدث الأحداث المعروضة' : 'No outstanding items in the latest sample'}
          </p>
        : <div className="space-y-2">
            {outstanding.map(item => <div key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs">
              <div className="space-y-1">
                <p className="font-medium">{item.event_kind === 'unresolved_identity'
                  ? (ar ? 'رقم مرسل غير محسوم' : 'Unresolved sender')
                  : (ar ? 'إيصال تسليم غير مطابق' : 'Unmatched delivery ACK')}</p>
                <p className="text-muted-foreground">
                  {item.state} · {ar ? 'المحاولات' : 'attempts'}: {item.attempt_count}
                  {item.last_error_code ? ` · ${item.last_error_code}` : ''}
                </p>
              </div>
              {item.state === 'review' && data?.may_retry && <Button variant="outline" size="sm"
                disabled={retrying !== null} onClick={() => void retry(item.id)}>
                <AlertCircle className="me-1 h-3 w-3" />
                {ar ? 'إعادة فحص' : 'Recheck'}
              </Button>}
            </div>)}
          </div>}
      <p className="text-xs text-muted-foreground">
        {ar ? 'إعادة الفحص لا تتجاوز ضوابط التحقق من الهوية، ولا تعيد إرسال الرسائل الصادرة.' :
          'Recheck does not bypass identity verification or resend outbound WhatsApp messages.'}
      </p>
    </>}
  </section>
}
