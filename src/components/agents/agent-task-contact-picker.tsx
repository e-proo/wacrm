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
  eligibilityById?: Record<string, { eligible: boolean; reason?: string }>
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


/**
 * One Task, multiple explicit CRM recipients. Each selected identity is shown
 * separately and verified against Coverage supplier eligibility before the
 * caller enables Create/Save. The server repeats that verification at commit.
 * Selecting a contact never initiates WhatsApp delivery.
 */
export function AgentTaskMultiContactPicker({
  selectedContactIds, onChange, coverageRequestId, maxSelected = 20,
  disabled = false, onEligibilityChange,
}: {
  selectedContactIds: readonly string[]
  onChange: (ids: string[]) => void
  coverageRequestId: string
  maxSelected?: number
  disabled?: boolean
  onEligibilityChange?: (eligible: boolean | null) => void
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Contact[]>([])
  const [chosen, setChosen] = useState<Contact[]>([])
  const [verified, setVerified] = useState<Record<string, { eligible: boolean; reason?: string }>>({})
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = selectedContactIds.join(',')

  useEffect(() => {
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const result = await fetchContacts(
          '/api/agent-tasks/contacts?q=' + encodeURIComponent(search), abort.signal,
        )
        if (!abort.signal.aborted) { setResults(result.contacts); setError(null) }
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'تعذّر البحث عن جهات الاتصال.')
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [search])

  useEffect(() => {
    if (!key || !coverageRequestId) {
      setChosen([])
      setVerified({})
      setChecking(false)
      onEligibilityChange?.(null)
      return
    }
    const abort = new AbortController()
    setChecking(true)
    setVerified({})
    onEligibilityChange?.(null)
    const verify = async () => {
      try {
        const params = new URLSearchParams({
          contactIds: key,
          coverageRequestId,
        })
        const response = await fetchContacts(
          '/api/agent-tasks/contacts?' + params.toString(), abort.signal,
        )
        if (abort.signal.aborted) return
        setChosen(response.contacts)
        const statuses = response.eligibilityById ?? {}
        setVerified(statuses)
        onEligibilityChange?.(selectedContactIds.every(id =>
          statuses[id]?.eligible === true &&
          response.contacts.some(contact => contact.id === id)))
        setError(null)
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'تعذّر التحقق من المستهدفين.')
          setChosen([])
          setVerified({})
          onEligibilityChange?.(false)
        }
      } finally {
        if (!abort.signal.aborted) setChecking(false)
      }
    }
    void verify()
    return () => abort.abort()
  // key uniquely captures the ordered selected IDs; avoid restarting checks
  // when only the parent array identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, coverageRequestId, onEligibilityChange])

  const known = useMemo(() => {
    const all = [...chosen, ...results]
    return new Map(all.map(contact => [contact.id, contact]))
  }, [chosen, results])
  const max = Math.max(1, Math.min(20, maxSelected))

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">الأرقام المستهدفة لهذه المهمة</p>
        <p className="text-xs text-muted-foreground">
          أضف عدة جهات من CRM بالاسم أو الرقم. سيتم التعامل مع كل رقم كمستهدف مستقل،
          ولن تُرسل رسالة لأي جهة غير مؤهلة أو غير مصرح لها بالإرسال.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        تم اختيار {selectedContactIds.length} من {max} مستهدفين متاحين لهذه المهمة
      </p>
      {selectedContactIds.length ? (
        <ul className="space-y-1" aria-label="الأرقام المختارة للمهمة">
          {selectedContactIds.map((id, index) => {
            const contact = known.get(id)
            const isAllowed = verified[id]?.eligible === true
            return (
              <li key={id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
                <span className="min-w-0 truncate">
                  {index + 1}. {contact?.name?.trim() || 'جهة اتصال'} · {contact?.phone ?? id.slice(0,8)}
                  {checking ? ' · جارٍ التحقق' : !isAllowed ? ' · غير مؤهلة' : ' · مؤهلة'}
                </span>
                <button type="button" disabled={disabled} className="shrink-0 text-destructive underline"
                  onClick={() => onChange(selectedContactIds.filter(value => value !== id))}>
                  إزالة
                </button>
              </li>
            )
          })}
        </ul>
      ) : <p className="text-xs text-muted-foreground">لم تحدد أي رقم بعد.</p>}
      <Input value={search} disabled={disabled || selectedContactIds.length >= max}
        onChange={e => setSearch(e.target.value)}
        placeholder="ابحث عن اسم أو رقم موجود في جهات الاتصال..."
        aria-label="البحث عن أرقام لإضافتها للمهمة" />
      <div className="max-h-44 space-y-1 overflow-y-auto">
        {results.filter(contact => !selectedContactIds.includes(contact.id)).map(contact => (
          <button key={contact.id} type="button"
            disabled={disabled || selectedContactIds.length >= max}
            onClick={() => onChange([...selectedContactIds, contact.id])}
            className="block w-full rounded-md border p-2 text-start text-sm hover:bg-muted disabled:opacity-50">
            + {contact.name?.trim() || 'بدون اسم'} · {contact.phone}
          </button>
        ))}
      </div>
      {loading ? <p className="text-xs text-muted-foreground">جارٍ تحميل النتائج...</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {selectedContactIds.length > 0 && !checking &&
        selectedContactIds.some(id => verified[id]?.eligible !== true) ? (
          <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
            واحدة أو أكثر من الجهات ليست مؤهلة لهذا الطلب. يلزم سجل عرض Coverage
            متوافق قبل إنشاء المهمة. لا يتم تجاوز الحظر أو الموافقة.
          </p>
        ) : null}
      {selectedContactIds.length > 0 && !checking &&
        selectedContactIds.every(id => verified[id]?.eligible === true) ? (
          <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
            جميع الجهات المختارة مؤهلة تجاريًا. فحوص موافقة WhatsApp والحدود
            والرسائل السابقة ستُطبّق مجددًا عند الإرسال لكل رقم.
          </p>
        ) : null}
    </div>
  )
}
