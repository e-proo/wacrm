'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import {
  ArrowRightLeft,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CurrenciesPanel } from '@/components/services/currencies-panel'

type Currency = {
  id: string
  code: string
  displayName: string
  symbol: string | null
  decimalDigits: number
  status: 'active' | 'disabled'
  kind: 'iso_4217' | 'historical' | 'local'
}

type Pair = {
  id: string
  accountId: string
  base: Currency
  quote: Currency
  status: 'active' | 'archived'
  currentRateVersionId: string | null
  lockVersion: number
  createdAt: string
  updatedAt: string
}

type PairWithRate = {
  pair: Pair
  currentRate: {
    rateVersionId: string
    versionNumber: number
    businessBuyRate: string
    businessSellRate: string
    source: string
    publishedAt: string
  } | null
}

type Overview = {
  baseCurrency: Currency | null
  currencies: Currency[]
  pairs: PairWithRate[]
  canManage: boolean
}

type HistoryRow = {
  id: string
  pairId: string
  versionNumber: number
  businessBuyRate: string
  businessSellRate: string
  source: string
  sourceChangeRequestId: string | null
  notesInternal: string | null
  publishedAt: string
  createdAt: string
}

type TradeStatus =
  | 'pending_admin'
  | 'approved_for_contact'
  | 'rejected'
  | 'completed'
  | 'cancelled'

type Trade = {
  id: string
  code: string
  pair: Pair
  side: 'customer_buy' | 'customer_sell'
  amountBasis: 'base' | 'quote'
  requestedAmount: string
  rateVersionId: string
  effectiveRate: string
  baseAmount: string
  quoteAmount: string
  status: TradeStatus
  decisionNote: string | null
  decidedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

type RateDraft = { buy: string; sell: string; notes: string }
type Tab = 'rates' | 'trades' | 'currencies' | 'settings'

const copy = {
  en: {
    rates: 'Rates', trades: 'Trade requests', currencies: 'Currencies', settings: 'FX settings',
    addPair: 'Add currency pair', base: 'Base currency', quote: 'Quote currency', select: 'Select currency', createPair: 'Create pair',
    noPairs: 'No FX pairs yet.', currentRate: 'Current rate', notPublished: 'No rate published', businessBuys: 'Business buys base', businessSells: 'Business sells base',
    version: 'Version', lock: 'Lock', published: 'Published', updateRate: 'Publish new rate', notes: 'Internal note (optional)', history: 'Rate history', hideHistory: 'Hide history', noHistory: 'No history yet.',
    baseSetting: 'Default FX counter currency', baseSettingHelp: 'Used as the default counter currency when a request names only one currency. It does not rewrite existing pairs or history.', save: 'Save',
    tradeFilter: 'Status', all: 'All', pending_admin: 'Pending admin', approved_for_contact: 'Approved for contact', rejected: 'Rejected', completed: 'Completed', cancelled: 'Cancelled',
    customer_buy: 'Customer buys base', customer_sell: 'Customer sells base', amount: 'Amount', rate: 'Rate', approve: 'Approve', reject: 'Reject', complete: 'Mark completed', cancel: 'Cancel', noTrades: 'No trade requests.',
    refresh: 'Refresh', readOnly: 'Read-only access. Admin role is required for changes.', active: 'Active', disabled: 'Disabled', error: 'Something went wrong',
  },
  ar: {
    rates: 'الأسعار', trades: 'طلبات الصرف', currencies: 'العملات', settings: 'إعدادات الصرف',
    addPair: 'إضافة زوج عملات', base: 'العملة الأساسية', quote: 'العملة المقابلة', select: 'اختر العملة', createPair: 'إنشاء الزوج',
    noPairs: 'لا توجد أزواج صرف حتى الآن.', currentRate: 'السعر الحالي', notPublished: 'لم يتم نشر سعر بعد', businessBuys: 'شراء المؤسسة للعملة الأساسية', businessSells: 'بيع المؤسسة للعملة الأساسية',
    version: 'النسخة', lock: 'قفل التزامن', published: 'نُشر', updateRate: 'نشر سعر جديد', notes: 'ملاحظة داخلية (اختياري)', history: 'سجل الأسعار', hideHistory: 'إخفاء السجل', noHistory: 'لا يوجد سجل بعد.',
    baseSetting: 'العملة المقابلة الافتراضية للصرف', baseSettingHelp: 'تستخدم كعملة مقابلة افتراضية عندما يذكر الطلب عملة واحدة فقط. تغييرها لا يعيد كتابة الأزواج أو السجل السابق.', save: 'حفظ',
    tradeFilter: 'الحالة', all: 'الكل', pending_admin: 'بانتظار الإدارة', approved_for_contact: 'مقبول للتواصل', rejected: 'مرفوض', completed: 'مكتمل', cancelled: 'ملغي',
    customer_buy: 'العميل يشتري العملة الأساسية', customer_sell: 'العميل يبيع العملة الأساسية', amount: 'المبلغ', rate: 'السعر', approve: 'قبول', reject: 'رفض', complete: 'تأكيد الاكتمال', cancel: 'إلغاء', noTrades: 'لا توجد طلبات صرف.',
    refresh: 'تحديث', readOnly: 'صلاحية قراءة فقط. التعديلات تتطلب دور Admin.', active: 'نشطة', disabled: 'معطلة', error: 'حدث خطأ',
  },
  ko: {
    rates: '환율', trades: '환전 요청', currencies: '통화', settings: 'FX 설정',
    addPair: '통화 쌍 추가', base: '기준 통화', quote: '상대 통화', select: '통화 선택', createPair: '쌍 생성',
    noPairs: '등록된 FX 쌍이 없습니다.', currentRate: '현재 환율', notPublished: '게시된 환율 없음', businessBuys: '사업자 기준통화 매입', businessSells: '사업자 기준통화 매도',
    version: '버전', lock: '잠금', published: '게시', updateRate: '새 환율 게시', notes: '내부 메모 (선택)', history: '환율 기록', hideHistory: '기록 숨기기', noHistory: '기록이 없습니다.',
    baseSetting: '기본 FX 상대 통화', baseSettingHelp: '요청에 통화가 하나만 있을 때 기본 상대 통화로 사용됩니다. 기존 쌍이나 기록은 변경하지 않습니다.', save: '저장',
    tradeFilter: '상태', all: '전체', pending_admin: '관리자 대기', approved_for_contact: '연락 승인', rejected: '거절', completed: '완료', cancelled: '취소',
    customer_buy: '고객 기준통화 매수', customer_sell: '고객 기준통화 매도', amount: '금액', rate: '환율', approve: '승인', reject: '거절', complete: '완료 처리', cancel: '취소', noTrades: '환전 요청이 없습니다.',
    refresh: '새로고침', readOnly: '읽기 전용입니다. 변경하려면 Admin 권한이 필요합니다.', active: '활성', disabled: '비활성', error: '오류가 발생했습니다',
  },
} as const

function compactNumber(value: string, digits = 8): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(n)
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function statusVariant(status: TradeStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'default'
  if (status === 'rejected') return 'destructive'
  if (status === 'cancelled') return 'outline'
  return 'secondary'
}

export function FxDashboard() {
  const locale = useLocale()
  const language = locale.startsWith('ar') ? 'ar' : locale.startsWith('ko') ? 'ko' : 'en'
  const t = copy[language]

  const [tab, setTab] = useState<Tab>('rates')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [trades, setTrades] = useState<Trade[] | null>(null)
  const [tradeStatus, setTradeStatus] = useState<TradeStatus | 'all'>('all')
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({})
  const [openHistory, setOpenHistory] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, RateDraft>>({})
  const [baseCode, setBaseCode] = useState('')
  const [newBase, setNewBase] = useState('')
  const [newQuote, setNewQuote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeCurrencies = useMemo(
    () => overview?.currencies.filter((currency) => currency.status === 'active') ?? [],
    [overview],
  )

  const loadOverview = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/fx-v2/overview', { cache: 'no-store' })
      const json = (await res.json()) as Overview & { error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      setOverview(json)
      setBaseCode(json.baseCurrency?.code ?? '')
      setDrafts((previous) => {
        const next = { ...previous }
        for (const item of json.pairs) {
          if (!next[item.pair.id]) {
            next[item.pair.id] = {
              buy: item.currentRate?.businessBuyRate ?? '',
              sell: item.currentRate?.businessSellRate ?? '',
              notes: '',
            }
          }
        }
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    }
  }, [t.error])

  const loadTrades = useCallback(async () => {
    setError(null)
    try {
      const query = tradeStatus === 'all' ? '' : `?status=${tradeStatus}`
      const res = await fetch(`/api/fx-v2/trades${query}`, { cache: 'no-store' })
      const json = (await res.json()) as { trades?: Trade[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      setTrades(json.trades ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    }
  }, [tradeStatus, t.error])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => {
    if (tab === 'trades') void loadTrades()
  }, [tab, loadTrades])

  async function createPair() {
    if (!newBase || !newQuote) return
    setBusy('createPair')
    setError(null)
    try {
      const res = await fetch('/api/fx-v2/pairs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseCode: newBase, quoteCode: newQuote }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      setNewBase('')
      setNewQuote('')
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    } finally {
      setBusy(null)
    }
  }

  async function saveBaseCurrency() {
    if (!baseCode) return
    setBusy('baseCurrency')
    setError(null)
    try {
      const res = await fetch('/api/fx-v2/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currencyCode: baseCode }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    } finally {
      setBusy(null)
    }
  }

  async function publishRate(item: PairWithRate) {
    const draft = drafts[item.pair.id]
    if (!draft?.buy || !draft.sell) return
    setBusy(`publish:${item.pair.id}`)
    setError(null)
    try {
      const res = await fetch(`/api/fx-v2/pairs/${item.pair.id}/rates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedLockVersion: item.pair.lockVersion,
          businessBuyRate: draft.buy,
          businessSellRate: draft.sell,
          notesInternal: draft.notes || null,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      setHistory((prev) => {
        const next = { ...prev }
        delete next[item.pair.id]
        return next
      })
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
      await loadOverview()
    } finally {
      setBusy(null)
    }
  }

  async function toggleHistory(pairId: string) {
    if (openHistory === pairId) {
      setOpenHistory(null)
      return
    }
    setOpenHistory(pairId)
    if (history[pairId]) return
    setBusy(`history:${pairId}`)
    try {
      const res = await fetch(`/api/fx-v2/pairs/${pairId}/history`, { cache: 'no-store' })
      const json = (await res.json()) as { history?: HistoryRow[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      setHistory((prev) => ({ ...prev, [pairId]: json.history ?? [] }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    } finally {
      setBusy(null)
    }
  }

  async function transitionTrade(id: string, action: 'approve' | 'reject' | 'complete' | 'cancel') {
    setBusy(`trade:${id}:${action}`)
    setError(null)
    try {
      const res = await fetch(`/api/fx-v2/trades/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? t.error)
      await loadTrades()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error)
    } finally {
      setBusy(null)
    }
  }

  if (!overview) {
    return (
      <div className="flex min-h-56 items-center justify-center text-muted-foreground">
        <Loader2 className="me-2 h-5 w-5 animate-spin" />
        Loading FX…
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!overview.canManage ? (
        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t.readOnly}
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="rates"><CircleDollarSign className="me-1.5 h-4 w-4" />{t.rates}</TabsTrigger>
            <TabsTrigger value="trades"><ArrowRightLeft className="me-1.5 h-4 w-4" />{t.trades}</TabsTrigger>
            <TabsTrigger value="currencies">{t.currencies}</TabsTrigger>
            <TabsTrigger value="settings"><Settings2 className="me-1.5 h-4 w-4" />{t.settings}</TabsTrigger>
          </TabsList>
          <Button variant="outline" size="sm" onClick={() => void (tab === 'trades' ? loadTrades() : loadOverview())}>
            <RefreshCw className="me-1.5 h-4 w-4" />{t.refresh}
          </Button>
        </div>

        <TabsContent value="rates" className="mt-5 space-y-5">
          {overview.canManage ? (
            <Card>
              <CardHeader><CardTitle className="text-base">{t.addPair}</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <CurrencySelect label={t.base} value={newBase} currencies={activeCurrencies} placeholder={t.select} onChange={setNewBase} />
                <CurrencySelect label={t.quote} value={newQuote} currencies={activeCurrencies} placeholder={t.select} onChange={setNewQuote} />
                <Button onClick={() => void createPair()} disabled={!newBase || !newQuote || newBase === newQuote || busy === 'createPair'}>
                  {busy === 'createPair' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Plus className="me-1.5 h-4 w-4" />}
                  {t.createPair}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {overview.pairs.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{t.noPairs}</CardContent></Card>
          ) : overview.pairs.map((item) => {
            const draft = drafts[item.pair.id] ?? { buy: '', sell: '', notes: '' }
            const historyRows = history[item.pair.id]
            return (
              <Card key={item.pair.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-lg" dir="ltr">
                      {item.pair.base.code}/{item.pair.quote.code}
                      <Badge variant="outline">{t.lock} {item.pair.lockVersion}</Badge>
                    </CardTitle>
                    {item.currentRate ? (
                      <div className="text-xs text-muted-foreground">
                        {t.version} {item.currentRate.versionNumber} · {t.published} {formatDate(item.currentRate.publishedAt)}
                      </div>
                    ) : <Badge variant="secondary">{t.notPublished}</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <RateMetric label={t.businessBuys} value={item.currentRate?.businessBuyRate ?? '—'} currency={item.pair.quote.code} />
                    <RateMetric label={t.businessSells} value={item.currentRate?.businessSellRate ?? '—'} currency={item.pair.quote.code} />
                  </div>

                  {overview.canManage ? (
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="space-y-1"><label className="text-xs font-medium">{t.businessBuys}</label><Input dir="ltr" inputMode="decimal" value={draft.buy} onChange={(e) => setDrafts((prev) => ({ ...prev, [item.pair.id]: { ...draft, buy: e.target.value } }))} /></div>
                        <div className="space-y-1"><label className="text-xs font-medium">{t.businessSells}</label><Input dir="ltr" inputMode="decimal" value={draft.sell} onChange={(e) => setDrafts((prev) => ({ ...prev, [item.pair.id]: { ...draft, sell: e.target.value } }))} /></div>
                        <div className="space-y-1"><label className="text-xs font-medium">{t.notes}</label><Input value={draft.notes} onChange={(e) => setDrafts((prev) => ({ ...prev, [item.pair.id]: { ...draft, notes: e.target.value } }))} /></div>
                      </div>
                      <Button className="mt-3" size="sm" onClick={() => void publishRate(item)} disabled={!draft.buy || !draft.sell || busy === `publish:${item.pair.id}`}>
                        {busy === `publish:${item.pair.id}` ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="me-1.5 h-4 w-4" />}
                        {t.updateRate}
                      </Button>
                    </div>
                  ) : null}

                  <Button variant="ghost" size="sm" onClick={() => void toggleHistory(item.pair.id)}>
                    {busy === `history:${item.pair.id}` ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <History className="me-1.5 h-4 w-4" />}
                    {openHistory === item.pair.id ? t.hideHistory : t.history}
                  </Button>
                  {openHistory === item.pair.id ? (
                    <div className="overflow-x-auto rounded-lg border">
                      {!historyRows?.length ? <div className="p-4 text-sm text-muted-foreground">{t.noHistory}</div> : (
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 text-start text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-start">{t.version}</th><th className="px-3 py-2 text-start">{t.businessBuys}</th><th className="px-3 py-2 text-start">{t.businessSells}</th><th className="px-3 py-2 text-start">{t.published}</th></tr></thead>
                          <tbody>{historyRows.map((row) => <tr key={row.id} className="border-t"><td className="px-3 py-2">#{row.versionNumber}</td><td className="px-3 py-2 font-mono" dir="ltr">{compactNumber(row.businessBuyRate)}</td><td className="px-3 py-2 font-mono" dir="ltr">{compactNumber(row.businessSellRate)}</td><td className="px-3 py-2 text-muted-foreground">{formatDate(row.publishedAt)}</td></tr>)}</tbody>
                        </table>
                      )}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            )
          })}
        </TabsContent>

        <TabsContent value="trades" className="mt-5 space-y-4">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t.tradeFilter}</label>
              <select className="rounded-md border bg-background px-3 py-2 text-sm" value={tradeStatus} onChange={(e) => setTradeStatus(e.target.value as TradeStatus | 'all')}>
                <option value="all">{t.all}</option>
                <option value="pending_admin">{t.pending_admin}</option>
                <option value="approved_for_contact">{t.approved_for_contact}</option>
                <option value="rejected">{t.rejected}</option>
                <option value="completed">{t.completed}</option>
                <option value="cancelled">{t.cancelled}</option>
              </select>
            </div>
          </div>
          {trades === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div> : trades.length === 0 ? <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{t.noTrades}</CardContent></Card> : trades.map((trade) => (
            <Card key={trade.id}>
              <CardContent className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">#{trade.code}</span><span className="font-mono" dir="ltr">{trade.pair.base.code}/{trade.pair.quote.code}</span><Badge variant={statusVariant(trade.status)}>{t[trade.status]}</Badge></div>
                    <p className="mt-1 text-sm text-muted-foreground">{t[trade.side]} · {formatDate(trade.createdAt)}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" dir="ltr"><span>{trade.pair.base.code}: <strong>{compactNumber(trade.baseAmount)}</strong></span><span>{trade.pair.quote.code}: <strong>{compactNumber(trade.quoteAmount)}</strong></span><span>{t.rate}: <strong>{compactNumber(trade.effectiveRate)}</strong></span><span>{t.amount}: <strong>{compactNumber(trade.requestedAmount)}</strong></span></div>
                </div>
                {overview.canManage ? <div className="mt-4 flex flex-wrap gap-2">
                  {trade.status === 'pending_admin' ? <><Button size="sm" onClick={() => void transitionTrade(trade.id, 'approve')} disabled={busy?.startsWith(`trade:${trade.id}:`) ?? false}><Check className="me-1.5 h-4 w-4" />{t.approve}</Button><Button size="sm" variant="destructive" onClick={() => void transitionTrade(trade.id, 'reject')} disabled={busy?.startsWith(`trade:${trade.id}:`) ?? false}><X className="me-1.5 h-4 w-4" />{t.reject}</Button></> : null}
                  {trade.status === 'approved_for_contact' ? <Button size="sm" onClick={() => void transitionTrade(trade.id, 'complete')} disabled={busy?.startsWith(`trade:${trade.id}:`) ?? false}><CheckCircle2 className="me-1.5 h-4 w-4" />{t.complete}</Button> : null}
                  {trade.status === 'pending_admin' || trade.status === 'approved_for_contact' ? <Button size="sm" variant="outline" onClick={() => void transitionTrade(trade.id, 'cancel')} disabled={busy?.startsWith(`trade:${trade.id}:`) ?? false}>{t.cancel}</Button> : null}
                </div> : null}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="currencies" className="mt-5">
          {overview.canManage ? (
            <CurrenciesPanel />
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {overview.currencies.map((currency) => (
                <Card key={currency.id}>
                  <CardContent className="space-y-2 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-lg font-bold">{currency.code}</span>
                      <Badge variant={currency.status === 'active' ? 'default' : 'secondary'}>
                        {currency.status === 'active' ? t.active : t.disabled}
                      </Badge>
                    </div>
                    <div className="text-sm">{currency.displayName}</div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {currency.symbol ? <span>{currency.symbol}</span> : null}
                      <span>{currency.decimalDigits}</span>
                      <span>{currency.kind}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="settings" className="mt-5">
          <Card>
            <CardHeader><CardTitle className="text-base">{t.baseSetting}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="max-w-2xl text-sm text-muted-foreground">{t.baseSettingHelp}</p>
              <div className="max-w-sm"><CurrencySelect value={baseCode} currencies={activeCurrencies} placeholder={t.select} onChange={setBaseCode} disabled={!overview.canManage} /></div>
              {overview.canManage ? <Button onClick={() => void saveBaseCurrency()} disabled={!baseCode || busy === 'baseCurrency'}>{busy === 'baseCurrency' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Settings2 className="me-1.5 h-4 w-4" />}{t.save}</Button> : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function CurrencySelect({ label, value, currencies, placeholder, onChange, disabled = false }: { label?: string; value: string; currencies: Currency[]; placeholder: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="space-y-1">{label ? <label className="text-sm font-medium">{label}</label> : null}<select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}><option value="">{placeholder}</option>{currencies.map((currency) => <option key={currency.id} value={currency.code}>{currency.code} — {currency.displayName}</option>)}</select></div>
}

function RateMetric({ label, value, currency }: { label: string; value: string; currency: string }) {
  return <div className="rounded-lg border bg-card px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><div className="mt-1 flex items-baseline gap-2" dir="ltr"><span className="font-mono text-xl font-semibold">{value === '—' ? value : compactNumber(value)}</span>{value !== '—' ? <span className="text-xs text-muted-foreground">{currency}</span> : null}</div></div>
}
