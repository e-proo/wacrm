'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { AlertCircle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { parseOpenWAApiResponse } from '@/lib/whatsapp/transport/openwa/browser-api-response'

type ReviewFinding = 'seen_on_whatsapp' | 'not_seen_on_whatsapp' | 'still_uncertain'
type ReviewRow = {
  message_id: string
  created_at: string
  sender_type: string
  content_type: string
}
type ReviewQueue = Record<string, unknown> & {
  items: ReviewRow[]
  unreviewed_count: number
  reviewed_uncertain_count: number
  error?: string
  updated?: boolean
}

export function OpenWAOutboundReview({
  connectionId, unsettled, reviewed, onReviewed,
}: {
  connectionId: string
  unsettled: number
  reviewed: number
  onReviewed: () => void
}) {
  const ar = useLocale().startsWith('ar')
  const [open, setOpen] = useState(false)
  const [queue, setQueue] = useState<ReviewQueue | null>(null)
  const [loading, setLoading] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [finding, setFinding] = useState<ReviewFinding>('still_uncertain')
  const [note, setNote] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const endpoint = `/api/whatsapp/connections/openwa/${connectionId}/outbound-review`
  const selected = queue?.items.find(item => item.message_id === selectedId) ?? null

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(endpoint, { cache: 'no-store' })
      const data = await parseOpenWAApiResponse<ReviewQueue>(res)
      if (!res.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || 'تعذّر تحميل سجل مراجعة الإرسال')
      }
      setQueue(data)
      setSelectedId(previous => previous && data.items.some(item => item.message_id === previous)
        ? previous : data.items[0]?.message_id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تحميل سجل المراجعة')
    } finally {
      setLoading(false)
    }
  }

  async function submitReview() {
    if (!selected || !acknowledged || note.trim().length < 12 || note.trim().length > 500 ||
        reviewing || loading) return
    if (!window.confirm(ar
      ? 'هل راجعت الرسالة على واتساب/سجلات OpenWA وتقبل بقاء نتيجتها غير مؤكدة دون إعادة إرسالها؟ هذه خطوة مراجعة وليست إثبات تسليم.'
      : 'Confirm you checked WhatsApp/OpenWA and accept the unresolved outcome without re-sending? This does not prove delivery.')) return
    setReviewing(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'acknowledge_no_resend',
          message_id: selected.message_id, finding,
          note: note.trim(), confirm_no_resend: true,
        }),
      })
      const data = await parseOpenWAApiResponse<ReviewQueue>(res)
      if (!res.ok || !data.updated) throw new Error(data.error || 'تعذّر تسجيل التسوية')
      setQueue(data)
      setSelectedId(data.items?.[0]?.message_id ?? null)
      setNote('')
      setFinding('still_uncertain')
      setAcknowledged(false)
      setNotice(ar
        ? 'حُفظت المراجعة في سجل تدقيق دائم، دون إرسال أو تغيير نتيجة الرسالة. يمكن إكمال إعدادات Pilot بعد استيفاء باقي الضوابط.'
        : 'Review audited. Delivery remains uncertain. No send or retry was performed.')
      onReviewed()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر تسجيل المراجعة')
    } finally {
      setReviewing(false)
    }
  }

  return <section className="space-y-3 rounded-lg border border-amber-300/60 p-4 dark:border-amber-700/60">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber-600" />
          <p className="font-semibold text-sm">
            {ar ? 'مراجعة رسائل الإرسال غير المحسومة' : 'Review ambiguous outbound sends'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={unsettled > 0 ? 'destructive' : 'outline'}>
            {ar ? 'تحتاج مراجعة' : 'Needs review'}: {unsettled}
          </Badge>
          {reviewed > 0 && <Badge variant="secondary">
            {ar ? 'مراجعة دون إثبات التسليم' : 'Audited, unconfirmed'}: {reviewed}
          </Badge>}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={loading || reviewing}
        onClick={() => {
          setOpen(!open)
          if (!open) void load()
        }}>
        <RefreshCw className="me-2 size-3" />
        {open ? (ar ? 'إخفاء التفاصيل' : 'Hide details') : (ar ? 'مراجعة الرسائل' : 'Review messages')}
      </Button>
    </div>

    <p className="text-xs text-muted-foreground">
      {ar
        ? 'هذه ليست إعادة إرسال ولا إثبات تسليم أو فشل. يُحتفظ بحالة sending ومفتاح منع التكرار، ويُسجّل قرارك لمتابعة تشغيل الجلسة على TEST.'
        : 'Not a resend or delivery/failure proof. The sending reservation and idempotency key stay intact; this is an audited TEST operator decision.'}
    </p>
    {error && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert><CheckCircle2 className="size-4" /><AlertDescription>{notice}</AlertDescription></Alert>}
    {open && <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{ar
          ? 'تحقق من المحادثة في واتساب ومن سجلات OpenWA عند وقت الرسالة قبل تسجيل المراجعة.'
          : 'Check the WhatsApp conversation and OpenWA logs at the message time before attesting.'}</p>
        <Button size="sm" variant="ghost" disabled={loading || reviewing} onClick={() => void load()}>
          <RefreshCw className="size-3" /> {ar ? 'تحديث' : 'Refresh'}
        </Button>
      </div>
      {queue && queue.items.length === 0 && <p className="text-sm text-muted-foreground">
        {ar ? 'لا توجد رسائل تنتظر مراجعة جديدة على هذه الجلسة.' : 'No unreviewed sends for this connection.'}
      </p>}
      {queue && queue.items.length > 0 && <>
        <div className="flex flex-wrap gap-2">
          {queue.items.map(item => <Button size="sm" key={item.message_id}
            variant={selectedId === item.message_id ? 'default' : 'outline'}
            disabled={reviewing} onClick={() => {
              setSelectedId(item.message_id)
              setFinding('still_uncertain')
              setNote('')
              setAcknowledged(false)
              setNotice(null)
            }}>
            {new Date(item.created_at).toLocaleString(ar ? 'ar' : 'en')}
          </Button>)}
        </div>
        {selected && <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="space-y-1 text-xs">
            <p>{ar ? 'تاريخ الرسالة' : 'Message time'}: {new Date(selected.created_at).toLocaleString(ar ? 'ar' : 'en')}</p>
            <p>{ar ? 'نوع الرسالة' : 'Message kind'}: {selected.sender_type} · {selected.content_type}</p>
            <p className="break-all text-muted-foreground">{selected.message_id}</p>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{ar ? 'ماذا لاحظت عند المراجعة؟' : 'What did you observe?'}</span>
            <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={finding} onChange={e => setFinding(e.target.value as ReviewFinding)}>
              <option value="seen_on_whatsapp">{ar ? 'رأيت الرسالة في واتساب' : 'Message seen in WhatsApp'}</option>
              <option value="not_seen_on_whatsapp">{ar ? 'لم أعثر على الرسالة في واتساب' : 'Message not seen in WhatsApp'}</option>
              <option value="still_uncertain">{ar ? 'لم أتمكن من تأكيد النتيجة' : 'Outcome still uncertain'}</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{ar ? 'ملاحظة المراجعة (12–500 حرف)' : 'Review note (12–500 characters)'}</span>
            <Input value={note} maxLength={500} onChange={e => setNote(e.target.value)}
              placeholder={ar ? 'مثال: راجعت المحادثة وسجل OpenWA؛ لا أرغب بإعادة الإرسال' : 'What did you inspect? No repeat send requested.'} />
          </label>
          <div className="flex items-start gap-2">
            <Checkbox id={`confirm-review-${selected.message_id}`} checked={acknowledged}
              onCheckedChange={value => setAcknowledged(value === true)} disabled={reviewing} />
            <label htmlFor={`confirm-review-${selected.message_id}`} className="cursor-pointer text-xs leading-relaxed">
              {ar
                ? 'أؤكد أنني راجعت الرسالة وأتفهم أنها قد تكون وصلت بالفعل. لن أعيد إرسال الرسالة بنفس المعرّف ولن أعتبر المراجعة إثبات نجاح أو فشل.'
                : 'I reviewed this send and understand it may already have reached WhatsApp. I will not resend it or treat this review as delivery/failure proof.'}
            </label>
          </div>
          <Button size="sm" disabled={!acknowledged || note.trim().length < 12 || note.trim().length > 500 || reviewing || loading}
            onClick={() => void submitReview()}>
            {reviewing ? (ar ? 'جارٍ حفظ المراجعة...' : 'Recording review...')
              : (ar ? 'تسجيل المراجعة دون إعادة إرسال' : 'Record review without resending')}
          </Button>
        </div>}
      </>}
    </div>}
  </section>
}
