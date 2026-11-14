'use client'

import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'

interface Contact {
  id: string
  name: string | null
  phone: string
}
interface ContactResponse {
  contacts: Contact[]
  eligibility: { eligible: boolean; reason?: string } | null
}

async function fetchContacts(url: string, signal: AbortSignal): Promise<ContactResponse> {
  const response = await fetch(url, { cache: 'no-store', signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error('تعذّر تحميل جهات الاتصال من WACRM')
  }
  return body as ContactResponse
}

/** Live, account-scoped CRM contacts. Never an independent outreach list.
 * A highlighted contact must still match the Coverage domain resolver and
 * pass DB tenant, consent, opt-out, budget and WhatsApp Pilot admission.
 */
export function AgentTaskContactPicker({
  selectedContactId, onChange, coverageRequestId, disabled = false,
  onEligibilityChange,
}: {
  selectedContactId: string | null
  onChange: (id: string | null) => void
  coverageRequestId: string
  disabled?: boolean
  onEligibilityChange?: (eligible: boolean | null) => void
}) {
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<Contact[]>([])
  const [chosen, setChosen] = useState<Contact | null>(null)
  const [eligible, setEligible] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search is server-side, limited and tenant-scoped. The user's query never
  // becomes SQL: only the API constructs a sanitized PostgREST expression.
  useEffect(() => {
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const result = await fetchContacts(
          '/api/agent-tasks/contacts?q=' + encodeURIComponent(search),
          abort.signal,
        )
        if (!abort.signal.aborted) { setItems(result.contacts); setError(null) }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'تعذّر تحميل جهات الاتصال.')
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => { clearTimeout(timer); abort.abort() }
  }, [search])

  // A selection is only a client-side preview. The Task creation service
  // independently performs the same domain eligibility check at commit time.
  useEffect(() => {
    if (!selectedContactId) {
      setChosen(null)
      setEligible(null)
      onEligibilityChange?.(null)
      return
    }
    const abort = new AbortController()
    const verify = async () => {
      setEligible(null)
      onEligibilityChange?.(null)
      try {
        const params = new URLSearchParams({
          contactId: selectedContactId,
          ...(coverageRequestId ? { coverageRequestId } : {}),
        })
        const result = await fetchContacts('/api/agent-tasks/contacts?' + params, abort.signal)
        if (abort.signal.aborted) return
        setChosen(result.contacts[0] ?? null)
        const value = coverageRequestId ? result.eligibility?.eligible === true : null
        setEligible(value)
        onEligibilityChange?.(value)
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'تعذّر التحقق من جهة الاتصال.')
          onEligibilityChange?.(false)
          setEligible(false)
        }
      }
    }
    void verify()
    return () => abort.abort()
  }, [selectedContactId, coverageRequestId, onEligibilityChange])

  const choices = useMemo(() => {
    const all = chosen ? [chosen, ...items] : items
    return all.filter((item, i, list) =>
      list.findIndex((candidate) => candidate.id === item.id) === i)
  }, [items, chosen])

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">جهة الاتصال المستهدفة من WACRM</p>
      <p className="text-xs text-muted-foreground">
        ابحث بالاسم أو الرقم واختر جهة موجودة. يجب أن تكون موردًا مؤهلًا
        لطلب Coverage، مع موافقة وسجل محادثة واتساب صالح.
      </p>
      <Input value={search} disabled={disabled}
        onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن اسم أو رقم جهة الاتصال..."
        aria-label="البحث في جهات الاتصال" />
      <select value={selectedContactId ?? ''} disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        aria-label="اختر جهة اتصال المهمة">
        <option value="">— اختر جهة اتصال صراحةً —</option>
        {choices.map((contact) => (
          <option key={contact.id} value={contact.id}>
            {contact.name?.trim() || 'بدون اسم'} · {contact.phone}
          </option>
        ))}
      </select>
      {loading ? <p className="text-xs text-muted-foreground">تحميل جهات الاتصال...</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {selectedContactId && coverageRequestId && eligible === false ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          جهة الاتصال ليست مؤهلة بعد لهذا الطلب: يلزم عرض Coverage متوافق.
          لن يُسمح بإنشاء مهمة ترسل إليها قبل تحقق الأهلية.
        </p>
      ) : null}
      {selectedContactId && coverageRequestId && eligible === true ? (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
          جهة الاتصال تطابق بيانات المورد لهذا الطلب. تظل صلاحيات الإرسال والحظر والاشتراك خاضعة لفحوص الخادم.
        </p>
      ) : null}
    </div>
  )
}
