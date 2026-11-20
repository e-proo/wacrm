'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

type Row = {
  id: string
  event_kind: 'unresolved_identity' | 'unmatched_status'
  state: 'pending' | 'leased' | 'completed' | 'review' | 'closed_unverified' | 'closed_archive_observed'
  attempt_count: number
  last_error_code: string | null
  created_at: string
  disposition_at?: string | null
  disposition_source?: 'admin_review' | 'owner_requested_test' | null
  disposition_code?: string | null
  disposition_gateway_status?: string | null
  ack_correlation?: 'needs_native_review' | 'candidate_outbound_message' |
    'candidate_broadcast_recipient' | 'inbound_only' | 'ambiguous_local_rows' | null
}
type Summary = {
  counts: Record<string, number>
  sample: Row[]
  may_retry: boolean
  ack_triage?: {
    sampled: number
    scope: 'sample_only'
    provider_verified: false
    categories: Record<string, number>
  }
}
export function OpenWAReconciliation({ connectionId }: { connectionId: string }) {
  const locale = useLocale()
  const ar = locale.startsWith('ar')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [phoneInputs, setPhoneInputs] = useState<Record<string, string>>({})
  const [nativeInspecting, setNativeInspecting] = useState<string | null>(null)
  const [closingAck, setClosingAck] = useState<string | null>(null)
  const [selectedAckIds, setSelectedAckIds] = useState<string[]>([])
  const [bulkClosing, setBulkClosing] = useState(false)
  const [nativeEvidence, setNativeEvidence] = useState<Record<string,
    { code: string; archive_status: string | null; whatsapp_delivery_confirmed: false }>>({})
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/reconciliation`

  async function refresh() {
    setLoading(true)
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      if (!res.ok) throw new Error('diagnostics_unavailable')
      const payload = await res.json() as Summary
      if (!payload || !Array.isArray(payload.sample)) throw new Error('invalid_response')
      setData(payload)
      const selectable = new Set(payload.sample
        .filter(item => item.event_kind === 'unmatched_status' &&
          (item.state === 'pending' || item.state === 'review'))
        .map(item => item.id))
      setSelectedAckIds(current => current.filter(id => selectable.has(id)))
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

  async function verifyPhone(jobId: string) {
    const phone = phoneInputs[jobId]?.trim()
    if (!phone) {
      toast.error(ar ? 'أدخل رقم الهاتف الدولي المراد التحقق منه' : 'Enter the international phone to verify')
      return
    }
    setRetrying(jobId)
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_phone', job_id: jobId, phone }),
      })
      if (!response.ok) throw new Error('provider_proof_rejected')
      setPhoneInputs((previous) => ({ ...previous, [jobId]: '' }))
      toast.success(ar
        ? 'تحقق OpenWA من الربط وأعاد الحدث للمعالجة الآمنة'
        : 'OpenWA verified the native pairing; the event is queued')
      await refresh()
    } catch {
      toast.error(ar
        ? 'لم يتمكن OpenWA من إثبات ربط هذا الرقم بالهوية الأصلية'
        : 'OpenWA could not verify this phone-to-LID pairing')
    } finally {
      setRetrying(null)
    }
  }

  // Explicit, read-only on-demand operator action. No WhatsApp sends or DB writes.
  async function inspectNativeAck(jobId: string) {
    if (nativeInspecting !== null) return
    setNativeInspecting(jobId)
    try {
      const response = await fetch(
        endpoint + '/' + encodeURIComponent(jobId) + '/native-evidence',
        { cache: 'no-store' },
      )
      const payload = await response.json() as {
        code?: string
        archive_status?: string | null
        whatsapp_delivery_confirmed?: false
      }
      if (!payload || typeof payload.code !== 'string') {
        throw new Error('unverifiable_response')
      }
      setNativeEvidence(previous => ({ ...previous, [jobId]: {
        code: payload.code!,
        archive_status: payload.archive_status ?? null,
        whatsapp_delivery_confirmed: false,
      } }))
      if (!response.ok && response.status >= 500) {
        toast.error(ar ? 'تعذّر الاتصال بأرشيف OpenWA؛ النتيجة غير مؤكدة' :
          'Unable to query OpenWA archive; outcome remains uncertain')
      }
    } catch {
      setNativeEvidence(previous => ({ ...previous, [jobId]: {
        code: 'gateway_unavailable', archive_status: null,
        whatsapp_delivery_confirmed: false,
      } }))
      toast.error(ar ? 'تعذّر فحص الدليل الأصلي' : 'Native evidence inspection failed')
    } finally {
      setNativeInspecting(null)
    }
  }

  async function closeSelectedUnverified() {
    if (bulkClosing || closingAck !== null || nativeInspecting !== null ||
        retrying !== null) return
    const selected = selectedAckIds.filter(id => data?.sample.some(item => item.id === id &&
      item.event_kind === 'unmatched_status' &&
      (item.state === 'pending' || item.state === 'review'))).slice(0,25)
    if (selected.length < 1) return
    const confirmed = window.confirm(ar
      ? 'هل تريد إغلاق ' + selected.length + ' إيصالًا محددًا كغير مؤكد؟\n' +
        'كل حالة تُفحص بشكل مستقل حسب الحساب والاتصال، ولن يتم إرسال أي رسالة أو تغيير حالة التسليم. ' +
        'قد تنجح بعض الحالات وتُرفض أخرى، وستعرض الواجهة النتائج.'
      : 'Close ' + selected.length + ' selected ACKs as UNVERIFIED?\n' +
        'Each case is independently scoped and reviewed. No message will be resent or marked delivered/failed. ' +
        'Some cases may be refused; individual outcomes will be shown.')
    if (!confirmed) return
    setBulkClosing(true)
    try {
      const response = await fetch(endpoint + '/bulk-disposition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action:'close_selected_unverified',
          job_ids: selected, confirm_no_resend:true }),
      })
      if (!response.ok) throw Error('bulk_rejected')
      const payload = await response.json() as {
        requested?: number
        closed?: number
        not_closed?: number
        results?: Array<{ job_id: string; result: string }>
      }
      if (payload.requested !== selected.length ||
          typeof payload.closed !== 'number' ||
          typeof payload.not_closed !== 'number' ||
          payload.closed + payload.not_closed !== selected.length ||
          !Array.isArray(payload.results) || payload.results.length !== selected.length) {
        throw Error('invalid_bulk_result')
      }
      const unclosed = payload.results
        .filter(item => item.result !== 'closed_unverified').map(item => item.job_id)
      setSelectedAckIds(unclosed)
      await refresh()
      if (payload.closed > 0) {
        toast.success(ar
          ? 'أُغلقت ' + payload.closed + ' حالة إداريًا دون إعادة إرسال أو تغيير حالة التسليم'
          : payload.closed + ' cases closed as unverified without resend or delivery status change')
      }
      if (payload.not_closed > 0) {
        toast.warning(ar
          ? 'بقيت ' + payload.not_closed + ' حالة دون إغلاق؛ راجع المطابقة أو حالة العامل'
          : payload.not_closed + ' cases were not closed; inspect local matches or job state')
      }
    } catch {
      toast.error(ar ? 'تعذّر تنفيذ التسوية الجماعية؛ لم يُؤكد إغلاق الحالات. حدّث القائمة.'
        : 'Bulk disposition was not confirmed; refresh the list before retrying.')
    } finally { setBulkClosing(false) }
  }

  const evidenceLabel = (code: string, status: string | null) => {
    if (code === 'archive_outbound_found')
      return ar
        ? 'سجل صادر مطابق في OpenWA' + (status ? ' · حالة الأرشيف: ' + status : '') + ' (ليس إثبات تسليم)'
        : 'Matching outgoing OpenWA archive row' + (status ? ' · stored: ' + status : '') + ' (not delivery proof)'
    if (code === 'not_in_gateway_archive')
      return ar ? 'لا يوجد سجل في أرشيف Gateway؛ لا يعني عدم الإرسال' :
        'Not in gateway archive; does not mean no send occurred'
    if (code === 'session_identity_unverified')
      return ar ? 'جلسة OpenWA غير مطابقة أو غير موثقة؛ لم يُعتمد الدليل' :
        'Gateway session identity not verified'
    if (code === 'native_reference_unsupported')
      return ar ? 'صيغة المعرّف غير مدعومة للفحص الأصلي' : 'Native reference unsupported'
    if (code === 'ambiguous_gateway_archive')
      return ar ? 'أكثر من سجل مطابق؛ تحتاج مراجعة' : 'Ambiguous provider archive rows'
    return ar ? 'لم يمكن إثبات حالة الأرشيف؛ تحتاج مراجعة' : 'Archive outcome unverified'
  }

  // Explicit admin disposition, never a delivery claim or permission to resend.
  async function closeAck(jobId: string, mode: 'close_unverified'|'close_archive_observed') {
    if (closingAck !== null || nativeInspecting !== null) return
    const acknowledged = window.confirm(
      mode === 'close_unverified'
        ? (ar
          ? 'إغلاق هذا الإيصال بأنه غير مؤكد؟ لن تُعدّل حالة الرسالة أو يُعاد إرسالها. قد يكون المزوّد قد أرسلها بالفعل.'
          : 'Close this ACK as UNVERIFIED? Message status will not change, and no message will be resent. It may already have been sent.')
        : (ar
          ? 'اعتماد وجود سجل صادر فقط، وليس إثبات تسليم الرسالة؟ لن يحدث إرسال أو تحديث لحالة التسليم.'
          : 'Record a verified outgoing gateway archive row only, NOT delivery proof? No message will be sent or marked delivered.')
    )
    if (!acknowledged) return
    setClosingAck(jobId)
    try {
      const response = await fetch(endpoint+'/'+encodeURIComponent(jobId)+'/disposition',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:mode,confirm_no_resend:true}),
      })
      if (!response.ok) throw new Error('disposition_denied')
      const payload = await response.json() as { updated?: boolean }
      if (payload.updated !== true) throw new Error('not_closed')
      setNativeEvidence(previous => {
        const next={...previous}
        delete next[jobId]
        return next
      })
      toast.success(ar ? 'تم تسجيل التسوية التشغيلية دون ادعاء التسليم أو إعادة الإرسال'
        : 'Operational disposition recorded without delivery claim or resend')
      await refresh()
    }catch {
      toast.error(ar ? 'تعذّر الإغلاق؛ قد تغيرت الحالة أو ظهرت مطابقة محلية. راجع البيانات أولًا.'
        : 'Disposition rejected: state changed, a local match exists, or service unavailable.')
    } finally { setClosingAck(null) }
  }

  const pending = Object.entries(data?.counts ?? {}).reduce((n, [k, v]) =>
    n + (k.endsWith(':pending') || k.endsWith(':leased') ? v : 0), 0)
  const review = Object.entries(data?.counts ?? {}).reduce((n, [k, v]) =>
    n + (k.endsWith(':review') ? v : 0), 0)
  const closedUnverified = data?.counts?.['unmatched_status:closed_unverified'] ?? 0
  const closedArchive = data?.counts?.['unmatched_status:closed_archive_observed'] ?? 0
  const recentClosed = data?.sample.filter(item => item.event_kind === 'unmatched_status' &&
    (item.state === 'closed_unverified' || item.state === 'closed_archive_observed')) ?? []
  const outstanding = data?.sample.filter(item => item.state === 'pending' ||
    item.state === 'leased' || item.state === 'review') ?? []
  const selectableAckIds = outstanding.filter(item => item.event_kind === 'unmatched_status' &&
    (item.state === 'pending' || item.state === 'review')).map(item => item.id)
  const selectedInSample = selectedAckIds.filter(id => selectableAckIds.includes(id))

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
        <Badge variant="outline">{ar ? 'أُغلقت دون إثبات' : 'Closed unverified'}: {closedUnverified}</Badge>
        <Badge variant="outline">{ar ? 'سجل أصلي فقط' : 'Archive observed'}: {closedArchive}</Badge>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className="me-1 h-3 w-3" />{ar ? 'تحديث' : 'Refresh'}
        </Button>
      </div>
      {data?.may_retry && selectableAckIds.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-xs">
        <Checkbox checked={selectedInSample.length > 0 &&
          selectedInSample.length === Math.min(25, selectableAckIds.length)}
          onCheckedChange={checked => setSelectedAckIds(
            checked ? selectableAckIds.slice(0,25) : [])}
          aria-label={ar ? 'تحديد الحالات القابلة للإغلاق من هذه الصفحة' :
            'Select closable ACKs from this page'} disabled={bulkClosing || closingAck !== null} />
        <span className="flex-1">
          {ar ? 'تحديد إيصالات ACK من النتائج المعروضة فقط' : 'Select ACKs from this visible sample only'}
          {' · '}{ar ? 'المحدد' : 'Selected'}: {selectedInSample.length}/25
        </span>
        <Button type="button" size="sm" variant="outline"
          disabled={selectedInSample.length === 0 || bulkClosing || closingAck !== null ||
            retrying !== null || nativeInspecting !== null}
          onClick={() => void closeSelectedUnverified()}>
          {bulkClosing ? (ar ? 'جارٍ تسجيل التسوية…' : 'Recording dispositions…') :
            (ar ? 'إغلاق المحدد كغير مؤكد' : 'Close selected as unverified')}
        </Button>
        <p className="basis-full text-muted-foreground">
          {ar
            ? 'حد أقصى 25 حالة لكل دفعة، لكل حالة تدقيق مستقل. لا يثبت الإغلاق نجاح الإرسال أو فشله.'
            : 'Up to 25 cases per batch, independently audited. Closure does not prove delivery or failure.'}
        </p>
      </div>}
      {(data?.ack_triage?.sampled ?? 0) > 0 && <div className="rounded-md border bg-muted/20 p-3 text-xs space-y-1">
        <p className="font-medium">
          {ar ? 'فحص مطابقة إيصالات ACK المحلية (قراءة فقط)' : 'Local ACK correlation (read-only)'}
        </p>
        <p className="text-muted-foreground">
          {ar ? 'الإيصالات المفحوصة في العينة:' : 'Sampled ACKs:'} {data?.ack_triage?.sampled ?? 0}
          {' · '}{ar ? 'لا توجد مطابقة محلية:' : 'No local match:'} {data?.ack_triage?.categories?.needs_native_review ?? 0}
          {' · '}{ar ? 'مطابقة محتملة:' : 'Local candidates:'} {
            (data?.ack_triage?.categories?.candidate_outbound_message ?? 0) +
            (data?.ack_triage?.categories?.candidate_broadcast_recipient ?? 0)}
          {' · '}{ar ? 'تعارض/وارد:' : 'Ambiguous/inbound:'} {
            (data?.ack_triage?.categories?.ambiguous_local_rows ?? 0) +
            (data?.ack_triage?.categories?.inbound_only ?? 0)}
        </p>
        <p className="text-muted-foreground">
          {ar
            ? 'المطابقة المحلية لا تثبت تسليم واتساب. الحالات غير المطابقة تحتاج مراجعة الدليل الأصلي لدى OpenWA، ولا تتم إعادة الإرسال.'
            : 'Local identity matches are not WhatsApp delivery proof. Unmatched events require native OpenWA review; never resend blindly.'}
        </p>
      </div>}
      {outstanding.length === 0
        ? <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            {ar ? 'لا توجد حالات عالقة ضمن أحدث الأحداث المعروضة' : 'No outstanding items in the latest sample'}
          </p>
        : <div className="space-y-2">
            {outstanding.map(item => <div key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs">
              <div className="flex items-start gap-2">
                {data?.may_retry && item.event_kind === 'unmatched_status' &&
                  (item.state === 'pending' || item.state === 'review') && <Checkbox
                  checked={selectedAckIds.includes(item.id)}
                  onCheckedChange={checked => setSelectedAckIds(current =>
                    checked
                      ? current.includes(item.id) ? current :
                        current.length >= 25 ? current : [...current,item.id]
                      : current.filter(id => id !== item.id))}
                  aria-label={ar ? 'تحديد إيصال ACK للتسوية' : 'Select ACK for disposition'}
                  disabled={bulkClosing || closingAck !== null || retrying !== null} />}
              <div className="space-y-1">
                <p className="font-medium">{item.event_kind === 'unresolved_identity'
                  ? (ar ? 'رقم مرسل غير محسوم' : 'Unresolved sender')
                  : (ar ? 'إيصال تسليم غير مطابق' : 'Unmatched delivery ACK')}</p>
                {item.event_kind === 'unmatched_status' && item.ack_correlation && <p className="text-amber-700 dark:text-amber-400">
                  {item.ack_correlation === 'needs_native_review'
                    ? (ar ? 'لا توجد مطابقة محلية؛ تتطلب مراجعة OpenWA' : 'No local match; review OpenWA evidence')
                    : item.ack_correlation === 'candidate_outbound_message'
                      ? (ar ? 'مطابقة محتملة مع رسالة صادرة' : 'Candidate local outbound match')
                      : item.ack_correlation === 'candidate_broadcast_recipient'
                        ? (ar ? 'مطابقة محتملة مع مستلم بث' : 'Candidate broadcast recipient')
                        : item.ack_correlation === 'inbound_only'
                          ? (ar ? 'مطابقة مع رسالة واردة فقط' : 'Inbound-only local row')
                          : (ar ? 'مطابقة محلية متعارضة؛ تحتاج مراجعة' : 'Ambiguous local records')}
                </p>}
                {item.event_kind === 'unmatched_status' && nativeEvidence[item.id] && <p role="status" className="text-xs text-blue-700 dark:text-blue-400">
                  {evidenceLabel(nativeEvidence[item.id].code, nativeEvidence[item.id].archive_status)}
                </p>}
                <p className="text-muted-foreground">
                  {item.state} · {ar ? 'المحاولات' : 'attempts'}: {item.attempt_count}
                  {item.last_error_code ? ` · ${item.last_error_code}` : ''}
                </p>
              </div>
              </div>
              {data?.may_retry && item.event_kind === 'unmatched_status' &&
                (item.state === 'pending' || item.state === 'review') && <Button type="button"
                  variant="outline" size="sm" disabled={nativeInspecting !== null || retrying !== null}
                  onClick={() => void inspectNativeAck(item.id)}>
                  <RefreshCw className="me-1 h-3 w-3" />
                  {nativeInspecting === item.id
                    ? (ar ? 'فحص الأرشيف…' : 'Checking archive…')
                    : (ar ? 'فحص سجل OpenWA' : 'Check OpenWA archive')}
                </Button>}
              {data?.may_retry && item.event_kind === 'unmatched_status' &&
                (item.state === 'pending' || item.state === 'review') && <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm"
                    disabled={closingAck !== null || nativeInspecting !== null || retrying !== null}
                    onClick={() => void closeAck(item.id,'close_unverified')}>
                    {closingAck === item.id ? (ar ? 'جارٍ الإغلاق…' : 'Closing…') :
                      (ar ? 'إغلاق غير مؤكد' : 'Close unverified')}
                  </Button>
                  {nativeEvidence[item.id]?.code === 'archive_outbound_found' &&
                    <Button type="button" variant="outline" size="sm"
                      disabled={closingAck !== null || nativeInspecting !== null || retrying !== null}
                      onClick={() => void closeAck(item.id,'close_archive_observed')}>
                      {ar ? 'توثيق سجل OpenWA' : 'Record OpenWA archive'}
                    </Button>}
                </div>}
              {data?.may_retry && (item.state === 'pending' || item.state === 'review') && <div className="flex flex-wrap items-center gap-2">
                {item.event_kind === 'unresolved_identity' && <>
                  <Input type="tel" inputMode="tel"
                    aria-label={ar ? 'رقم الهاتف الدولي' : 'International phone number'}
                    placeholder={ar ? 'رقم الهاتف الدولي' : 'International phone'}
                    className="h-8 w-40 text-xs" value={phoneInputs[item.id] ?? ''}
                    onChange={(event) => setPhoneInputs((previous) => ({
                      ...previous, [item.id]: event.target.value,
                    }))} />
                  <Button variant="outline" size="sm" disabled={retrying !== null}
                    onClick={() => void verifyPhone(item.id)}>
                    {ar ? 'تحقق من OpenWA' : 'Verify with OpenWA'}
                  </Button>
                </>}
                {item.state === 'review' && <Button variant="outline" size="sm"
                  disabled={retrying !== null} onClick={() => void retry(item.id)}>
                  <AlertCircle className="me-1 h-3 w-3" />
                  {ar ? 'إعادة فحص' : 'Recheck'}
                </Button>}
              </div>}
            </div>)}
          </div>}
      {recentClosed.length > 0 && <div className="rounded-md border bg-muted/20 p-3 text-xs space-y-1">
        <p className="font-semibold">{ar ? 'سجل الإغلاقات الأخيرة (العينة)' : 'Recently closed ACKs (sample)'}</p>
        <p className="text-muted-foreground">
          {ar
            ? 'تظل الحالات مغلقة إداريًا فقط؛ حالة التسليم الأصلية لم تتغير. لا تعني مغلق/غير مؤكد أن الرسالة فشلت.'
            : 'These are operational closures only. Original delivery state was not changed. Unverified does not mean failed.'}
        </p>
        <p>{ar ? 'عدد السجلات المعروضة:' : 'Displayed records:'} {recentClosed.length}</p>
        <div className="max-h-56 space-y-1 overflow-auto">
          {recentClosed.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-2 rounded border p-2">
            <span>{item.state === 'closed_unverified'
              ? (ar ? 'غير مؤكدة' : 'Unverified') : (ar ? 'سجل OpenWA' : 'Gateway archive')}</span>
            <span className="text-muted-foreground">{item.disposition_source === 'owner_requested_test'
              ? (ar ? 'إغلاق TEST بتفويض المالك' : 'TEST owner-authorized closure')
              : (ar ? 'مراجعة مسؤول' : 'Admin review')}</span>
            <span className="text-muted-foreground">{item.disposition_at
              ? new Date(item.disposition_at).toLocaleString(ar ? 'ar' : 'en') : ''}</span>
          </div>)}
        </div>
      </div>}
      <p className="text-xs text-muted-foreground">
        {ar ? 'إعادة الفحص لا تتجاوز ضوابط التحقق من الهوية، ولا تعيد إرسال الرسائل الصادرة.' :
          'Recheck does not bypass identity verification or resend outbound WhatsApp messages.'}
      </p>
    </>}
  </section>
}
