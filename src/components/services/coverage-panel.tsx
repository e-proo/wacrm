'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDownUp,
  Handshake,
  Layers,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

// ============================================================
// Coverage marketplace panel v2.
//
// Four sub-views:
//   Offers       — liquidity a provider contact supplies (with
//                  commission per-thousand + deal date).
//   Requests     — liquidity a requester contact needs (no
//                  commission: they review offers WITH theirs).
//   Suggestions  — live matches computed by the engine (singles
//                  + bundles with a fit score), booked leg by leg
//                  through the atomic RPC.
//   Matches      — reservations with their commission snapshot.
//
// Lifecycle (activate / cancel / fulfill / expire) goes through
// PATCH /api/coverage/offers|requests/:id.
// ============================================================

interface CoverageAttrs {
  coverage_scope?: string;
  coverage_country?: string | null;
  receive_region_id?: string | null;
  receive_method?: string;
  pay_region_id?: string | null;
  pay_method?: string;
}

interface OfferRow {
  id: string;
  service_id: string;
  provider_contact_id: string;
  reference_code: string;
  total_amount: string;
  reserved_amount: string;
  fulfilled_amount: string;
  currency: string;
  attributes: CoverageAttrs;
  commission_per_thousand: string | null;
  commission_currency: string | null;
  commission_amount: string | null;
  deal_date: string;
  status: string;
}

interface RequestRow {
  id: string;
  service_id: string;
  requester_contact_id: string;
  requested_amount: string;
  reserved_amount: string;
  fulfilled_amount: string;
  currency: string;
  attributes: CoverageAttrs;
  commission_per_thousand: string | null;
  commission_currency: string | null;
  commission_amount: string | null;
  deal_date: string;
  priority: string;
  status: string;
}

interface MatchRow {
  id: string;
  offer_id: string;
  request_id: string;
  matched_amount: string;
  currency: string;
  fee_snapshot: Record<string, unknown> | null;
  status: string;
  created_at: string;
}

interface ContactOption {
  id: string;
  name: string;
  phone: string;
}

interface ServiceOption {
  id: string;
  name: string;
  code: string;
}

interface RegionOption {
  id: string;
  code: string;
  name: string;
  macro_region: 'north' | 'south' | 'international';
  status: string;
}

interface CurrencyOption {
  id: string;
  code: string;
  display_name: string;
}

interface ComplementaryPair {
  a_type: 'offer' | 'request';
  a_id: string;
  b_type: 'offer' | 'request';
  b_id: string;
  currency: string;
  amount: string;
  score: number;
}

interface SuggestionLeg {
  offer_id: string;
  request_id: string;
  amount: string;
  currency: string;
  score: number;
  region_score: number;
  method_score: number;
  orientation: 'direct' | 'mirror';
  commission_per_thousand: string | null;
  commission_currency: string;
  commission_amount: string;
  offer_headroom: string;
  offer_headroom_after: string;
  request_remaining: string;
  request_remaining_after: string;
}

interface RequestSuggestions {
  request_id: string;
  currency: string;
  request_remaining: string;
  singles: SuggestionLeg[];
  bundle: SuggestionLeg[] | null;
  bundle_coverage: number;
  bundle_commission_amount: string;
  fully_coverable: boolean;
}

type View = 'offers' | 'requests' | 'suggestions' | 'matches';

const METHODS = ['cash', 'networks', 'bank_deposit', 'any'] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CoveragePanel() {
  const t = useTranslations('Coverage');
  const [view, setView] = useState<View>('offers');
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  // Endpoints that failed during the last load — surfaced instead
  // of silently empty dropdowns.
  const [loadProblems, setLoadProblems] = useState<string[]>([]);
  // ظ†ظˆط¹ ط§ظ„طھط؛ط·ظٹط© ط¯ط§ط®ظ„ ط§ظ„ظ†ظ…ظˆط°ط¬ ط§ظ„ظ…ظˆط­ظ‘ط¯: ط¹ط±ط¶ ط£ظ… ط·ظ„ط¨.
  const [createType, setCreateType] = useState<'offer' | 'request'>('offer');

  // Create form (shared between offer / request types).
  const [oContact, setOContact] = useState('');
  const [oAmount, setOAmount] = useState('');
  const [oCurrency, setOCurrency] = useState('SAR');
  const [oScope, setOScope] = useState<'domestic' | 'international'>('domestic');
  const [oCountry, setOCountry] = useState('');
  const [oReceiveRegion, setOReceiveRegion] = useState('');
  const [oReceiveMethod, setOReceiveMethod] = useState('any');
  const [oPayRegion, setOPayRegion] = useState('');
  const [oPayMethod, setOPayMethod] = useState('any');
  const [oCommissionRate, setOCommissionRate] = useState('');
  const [oCommissionCurrency, setOCommissionCurrency] = useState('SAR');
  const [oDealDate, setODealDate] = useState(today());
  const [rPriority, setRPriority] = useState<'low' | 'normal' | 'high'>('normal');

  // Suggestions view.
  const [sRequestId, setSRequestId] = useState('');
  const [suggestions, setSuggestions] = useState<RequestSuggestions | null>(null);
  const [complementaryPairs, setComplementaryPairs] = useState<ComplementaryPair[]>([]);

  // Match form.
  const [mOffer, setMOffer] = useState('');
  const [mRequest, setMRequest] = useState('');
  const [mAmount, setMAmount] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const problems: string[] = [];
    const get = async (url: string): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          problems.push(`${url} (${res.status})`);
          return null;
        }
        return (await res.json()) as Record<string, unknown>;
      } catch {
        problems.push(`${url} (network)`);
        return null;
      }
    };
    const [o, r, m, c, s, rg, cur] = await Promise.all([
      get('/api/coverage/offers'),
      get('/api/coverage/requests'),
      get('/api/coverage/matches'),
      get('/api/contacts-lite'),
      get('/api/services'),
      get('/api/coverage/regions'),
      get('/api/currencies/active'),
    ]);
    setOffers((o?.offers as OfferRow[] | undefined) ?? []);
    setRequests((r?.requests as RequestRow[] | undefined) ?? []);
    setMatches((m?.matches as MatchRow[] | undefined) ?? []);
    setContacts((c?.contacts as ContactOption[] | undefined) ?? []);
    setServices((s?.services as ServiceOption[] | undefined) ?? []);
    setRegions((rg?.regions as RegionOption[] | undefined) ?? []);
    setCurrencies((cur?.currencies as CurrencyOption[] | undefined) ?? []);
    setLoadProblems(problems);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSuggestions = useCallback(async (requestId: string) => {
    setSuggestions(null);
    if (!requestId) {
      // No request selected → overview: same-type anti-parallel
      // rows (e.g. two offers that are actually offer vs request).
      try {
        const res = await fetch('/api/coverage/suggestions', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as { complementaryPairs?: ComplementaryPair[] };
          setComplementaryPairs(json.complementaryPairs ?? []);
        } else {
          setComplementaryPairs([]);
        }
      } catch {
        setComplementaryPairs([]);
      }
      return;
    }
    setComplementaryPairs([]);
    const res = await fetch(`/api/coverage/suggestions?requestId=${requestId}`, {
      cache: 'no-store',
    });
    if (res.ok) {
      setSuggestions((await res.json()) as RequestSuggestions);
    }
  }, []);

  useEffect(() => {
    if (view === 'suggestions') void loadSuggestions(sRequestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function attrsFrom(
    scope: string,
    country: string,
    receiveRegion: string,
    receiveMethod: string,
    payRegion: string,
    payMethod: string,
  ): Record<string, unknown> {
    return {
      coverage_scope: scope,
      ...(scope === 'international' && country ? { coverage_country: country } : {}),
      receive_region_id: receiveRegion || null,
      receive_method: receiveMethod,
      pay_region_id: payRegion || null,
      pay_method: payMethod,
    };
  }

  // The account's dedicated coverage service (migration 060 seeds
  // it automatically) — every coverage row shares it, so the
  // operator never manages the catalog from here.
  const coverageService =
    (services ?? []).find((s) => s.code === 'coverage') ??
    (services ?? [])[0];

  async function createOffer() {
    setBusy('offer');
    setError(null);
    try {
      const res = await fetch('/api/coverage/offers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId: coverageService?.id ?? '',
          providerContactId: oContact,
          referenceCode: `OFF-${Date.now()}`,
          totalAmount: oAmount,
          currency: oCurrency,
          attributes: attrsFrom(oScope, oCountry, oReceiveRegion, oReceiveMethod, oPayRegion, oPayMethod),
          commissionPerThousand: oCommissionRate === '' ? null : oCommissionRate,
          commissionCurrency: oCommissionRate === '' ? null : oCommissionCurrency,
          dealDate: oDealDate || today(),
        }),
      });
      const json = (await res.json()) as { offer?: OfferRow; error?: string };
      if (!res.ok || !json.offer) throw new Error(json.error ?? 'Create failed');
      setShowForm(false);
      setOAmount('');
      setOCommissionRate('');
      await load();
      setView('offers');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function createRequest() {
    setBusy('request');
    setError(null);
    try {
      const res = await fetch('/api/coverage/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId: coverageService?.id ?? '',
          requesterContactId: oContact,
          requestedAmount: oAmount,
          currency: oCurrency,
          priority: rPriority,
          attributes: attrsFrom(oScope, oCountry, oReceiveRegion, oReceiveMethod, oPayRegion, oPayMethod),
          commissionPerThousand: oCommissionRate === '' ? null : oCommissionRate,
          commissionCurrency: oCommissionRate === '' ? null : oCommissionCurrency,
          dealDate: oDealDate || today(),
        }),
      });
      const json = (await res.json()) as { request?: RequestRow; error?: string };
      if (!res.ok || !json.request) throw new Error(json.error ?? 'Create failed');
      setShowForm(false);
      setOAmount('');
      await load();
      setView('requests');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function rowAction(
    kind: 'offers' | 'requests',
    id: string,
    action: 'activate' | 'cancel' | 'fulfill' | 'expire',
  ) {
    setBusy(`${action}:${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/coverage/${kind}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Action failed');
      }
      await load();
      if (view === 'suggestions') await loadSuggestions(sRequestId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function bookLeg(offerId: string, requestId: string, amount: string, currency: string) {
    setBusy(`book:${offerId}:${requestId}`);
    setError(null);
    try {
      const res = await fetch('/api/coverage/matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offerId,
          requestId,
          matchedAmount: amount,
          currency,
          idempotencyKey: `match-${offerId}-${requestId}-${Date.now()}`,
        }),
      });
      const json = (await res.json()) as { matchId?: string; error?: string };
      if (!res.ok || !json.matchId) throw new Error(json.error ?? 'Booking failed');
      await Promise.all([load(), loadSuggestions(sRequestId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function reserveMatch() {
    setBusy('match');
    setError(null);
    try {
      const res = await fetch('/api/coverage/matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offerId: mOffer,
          requestId: mRequest,
          matchedAmount: mAmount,
          currency: activeCurrency ?? 'YER',
          idempotencyKey: `match-${mOffer}-${mRequest}-${Date.now()}`,
        }),
      });
      const json = (await res.json()) as { matchId?: string; error?: string; code?: string };
      if (!res.ok || !json.matchId) throw new Error(json.error ?? 'Booking failed');
      setMAmount('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function releaseMatch(id: string) {
    setBusy(`release:${id}`);
    setError(null);
    try {
      const res = await fetch('/api/coverage/matches', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Release failed');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  const bookableOffers = (offers ?? []).filter(
    (o) => o.status === 'active' || o.status === 'partially_reserved',
  );
  const activeCurrency = mOffer
    ? (offers ?? []).find((o) => o.id === mOffer)?.currency
    : undefined;
  const bookableRequests = (requests ?? []).filter(
    (r) => r.status === 'active' || r.status === 'partially_reserved',
  );

  function remaining(o: { total_amount: string; reserved_amount: string; fulfilled_amount: string }) {
    const total = Number(o.total_amount);
    const used = Number(o.reserved_amount) + Number(o.fulfilled_amount);
    return Math.max(total - used, 0);
  }

  function contactName(id: string | undefined): string {
    if (!id) return '—';
    const c = contacts.find((x) => x.id === id);
    return c ? c.name || c.phone : '—';
  }

  function regionLabel(id: string | null | undefined): string {
    if (!id) return t('noRegion');
    const r = regions.find((x) => x.id === id);
    if (!r) return t('noRegion');
    const macro =
      r.macro_region === 'north'
        ? t('macroNorth')
        : r.macro_region === 'south'
          ? t('macroSouth')
          : t('macroInternational');
    return `${r.name} (${macro})`;
  }

  function methodLabel(m: string | undefined): string {
    switch (m) {
      case 'cash':
        return t('methodCash');
      case 'networks':
        return t('methodNetworks');
      case 'bank_deposit':
        return t('methodBankDeposit');
      default:
        return t('methodAny');
    }
  }

  function statusLabel(s: string): string {
    switch (s) {
      case 'draft':
        return t('statusDraft');
      case 'active':
        return t('statusActive');
      case 'partially_reserved':
        return t('statusPartiallyReserved');
      case 'fully_reserved':
        return t('statusFullyReserved');
      case 'fulfilled':
        return t('statusFulfilled');
      case 'expired':
        return t('statusExpired');
      default:
        return t('statusCancelled');
    }
  }

  function RowActions({
    kind,
    row,
  }: {
    kind: 'offers' | 'requests';
    row: OfferRow | RequestRow;
  }) {
    const actions: Array<'activate' | 'cancel' | 'fulfill' | 'expire'> = [];
    if (row.status === 'draft') {
      actions.push('activate', 'cancel');
    } else if (['active', 'partially_reserved', 'fully_reserved'].includes(row.status)) {
      actions.push('fulfill', 'expire', 'cancel');
    }
    if (actions.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((a) => (
          <Button
            key={a}
            size="sm"
            variant={a === 'activate' ? 'default' : 'outline'}
            disabled={busy === `${a}:${row.id}`}
            onClick={() => void rowAction(kind, row.id, a)}
          >
            {busy === `${a}:${row.id}` ? (
              <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t(a)}
          </Button>
        ))}
      </div>
    );
  }

  function RegionSelect({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) {
    const north = regions.filter((r) => r.macro_region === 'north' && r.status === 'active');
    const south = regions.filter((r) => r.macro_region === 'south' && r.status === 'active');
    const intl = regions.filter((r) => r.macro_region === 'international' && r.status === 'active');
    return (
      <select
        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('noRegion')}</option>
        {north.length > 0 ? (
          <optgroup label={t('macroNorth')}>
            {north.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
        ) : null}
        {south.length > 0 ? (
          <optgroup label={t('macroSouth')}>
            {south.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
        ) : null}
        {intl.length > 0 ? (
          <optgroup label={t('macroInternational')}>
            {intl.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
        ) : null}
      </select>
    );
  }

  function CurrencySelect({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) {
    if (currencies.length === 0) {
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
      );
    }
    // Known codes get a localized label via i18n; anything else
    // shows its raw code (never the DB free-text display_name).
    const label = (code: string): string => {
      const candidates = [
        `currency${code.replace(/[^A-Za-z0-9]/g, '_')}`,
        `currency${code.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}`,
      ];
      for (const key of candidates) {
        try {
          const v = t(key as Parameters<typeof t>[0]);
          if (v && v !== key) return v;
        } catch {
          // missing key — fall through
        }
      }
      return code;
    };
    return (
      <select
        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {currencies.map((c) => (
          <option key={c.id} value={c.code}>{label(c.code)}</option>
        ))}
      </select>
    );
  }

  function ScopeFields({
    scope,
    setScope,
    country,
    setCountry,
  }: {
    scope: 'domestic' | 'international';
    setScope: (v: 'domestic' | 'international') => void;
    country: string;
    setCountry: (v: string) => void;
  }) {
    return (
      <>
        <Field label={t('scope')}>
          <select
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="domestic">{t('scopeDomestic')}</option>
            <option value="international">{t('scopeInternational')}</option>
          </select>
        </Field>
        {scope === 'international' ? (
          <Field label={t('country')}>
            <Input value={country} onChange={(e) => setCountry(e.target.value)} />
          </Field>
        ) : null}
      </>
    );
  }

  function MethodSelect({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) {
    return (
      <select
        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>{methodLabel(m)}</option>
        ))}
      </select>
    );
  }

  const commissionPreview = (() => {
    const amt = Number(oAmount);
    const rate = Number(oCommissionRate);
    if (!Number.isFinite(amt) || !Number.isFinite(rate) || amt <= 0 || rate < 0) return null;
    return ((amt * rate) / 1000).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
  })();

  return (
    <div className="space-y-5">
      {loadProblems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span>
            {t('loadProblems')} <code className="font-mono text-xs">{loadProblems.join(', ')}</code>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={() => void load()}
          >
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* View switch */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={view === 'offers' ? 'default' : 'outline'}
          onClick={() => setView('offers')}
        >
          <ShieldCheck className="me-1.5 h-4 w-4" /> {t('offers')}
        </Button>
        <Button
          size="sm"
          variant={view === 'requests' ? 'default' : 'outline'}
          onClick={() => setView('requests')}
        >
          <Search className="me-1.5 h-4 w-4" /> {t('requests')}
        </Button>
        <Button
          size="sm"
          variant={view === 'suggestions' ? 'default' : 'outline'}
          onClick={() => setView('suggestions')}
        >
          <Layers className="me-1.5 h-4 w-4" /> {t('suggestions')}
        </Button>
        <Button
          size="sm"
          variant={view === 'matches' ? 'default' : 'outline'}
          onClick={() => setView('matches')}
        >
          <ArrowDownUp className="me-1.5 h-4 w-4" /> {t('matches')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ms-auto"
          onClick={() => {
            setCreateType(view === 'requests' ? 'request' : 'offer');
            setShowForm((v) => !v);
          }}
        >
          {showForm ? <X className="me-1.5 h-4 w-4" /> : <Plus className="me-1.5 h-4 w-4" />}
          {t('new')}
        </Button>
      </div>

      {/* Unified create form — type chosen inside the form */}
      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {createType === 'offer' ? t('newOffer') : t('newRequest')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={t('coverageType')}>
                <select
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                  value={createType}
                  onChange={(e) => setCreateType(e.target.value as 'offer' | 'request')}
                >
                  <option value="offer">{t('typeOffer')}</option>
                  <option value="request">{t('typeRequest')}</option>
                </select>
              </Field>
              <Field label={t('contact')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={oContact} onChange={(e) => setOContact(e.target.value)}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone}</option>)}
                </select>
              </Field>
              <Field label={t('amount')}>
                <Input value={oAmount} onChange={(e) => setOAmount(e.target.value)} inputMode="decimal" />
              </Field>
              <Field label={t('currency')}>
                <CurrencySelect value={oCurrency} onChange={setOCurrency} />
              </Field>
              <Field label={t('dealDate')}>
                <Input type="date" value={oDealDate} onChange={(e) => setODealDate(e.target.value)} />
              </Field>
              <ScopeFields scope={oScope} setScope={setOScope} country={oCountry} setCountry={setOCountry} />
              <Field label={t('receiveRegion')}>
                <RegionSelect value={oReceiveRegion} onChange={setOReceiveRegion} />
              </Field>
              <Field label={t('receiveMethod')}>
                <MethodSelect value={oReceiveMethod} onChange={setOReceiveMethod} />
              </Field>
              <Field label={t('payRegion')}>
                <RegionSelect value={oPayRegion} onChange={setOPayRegion} />
              </Field>
              <Field label={t('payMethod')}>
                <MethodSelect value={oPayMethod} onChange={setOPayMethod} />
              </Field>
              <Field label={t('commissionRate')}>
                <Input
                  value={oCommissionRate}
                  onChange={(e) => setOCommissionRate(e.target.value)}
                  inputMode="decimal"
                  placeholder="7"
                />
              </Field>
              <Field label={t('commissionCurrency')}>
                <CurrencySelect value={oCommissionCurrency} onChange={setOCommissionCurrency} />
              </Field>
              {createType === 'request' ? (
                <Field label={t('priority')}>
                  <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={rPriority} onChange={(e) => setRPriority(e.target.value as typeof rPriority)}>
                    <option value="low">{t('low')}</option>
                    <option value="normal">{t('normal')}</option>
                    <option value="high">{t('high')}</option>
                  </select>
                </Field>
              ) : null}
            </div>
            {oCommissionRate !== '' ? (
              <div className="rounded bg-muted px-3 py-2 text-sm">
                <span className="font-medium">{t('commissionAmount')}: </span>
                <span className="font-mono">
                  {commissionPreview ?? '—'} {oCommissionCurrency}
                </span>
                <span className="ms-2 text-xs text-muted-foreground">
                  {t('commissionEquation')}
                </span>
              </div>
            ) : null}
            <Button
              onClick={() => void (createType === 'offer' ? createOffer() : createRequest())}
              disabled={busy !== null || !oContact || !oAmount}
            >
              {busy ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Plus className="me-1.5 h-4 w-4" />}
              {t('create')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Offers view */}
      {view === 'offers' ? (
        offers === null ? (
          <Spinner />
        ) : offers.length === 0 ? (
          <Empty label={t('emptyOffers')} />
        ) : (
          <div className="space-y-2">
            {offers.map((o) => {
              const rem = remaining(o);
              const pct = Number(o.total_amount) > 0 ? Math.round((rem / Number(o.total_amount)) * 100) : 0;
              return (
                <Card key={o.id}>
                  <CardContent className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Handshake className="h-4 w-4 text-primary" />
                      <code className="font-mono text-xs">{o.reference_code}</code>
                      <Badge variant="outline">{statusLabel(o.status)}</Badge>
                      <span className="ms-auto font-mono text-sm">
                        {o.total_amount} {o.currency}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded bg-emerald-500/70"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('remaining')}: {rem} / {o.total_amount} {o.currency}
                      {o.commission_per_thousand ? (
                        <>
                          {' آ· '}
                          {t('commissionRate')}: {o.commission_per_thousand} ({t('commissionAmount')}: {o.commission_amount} {o.commission_currency})
                        </>
                      ) : null}
                      {' آ· '}
                      {t('dealDate')}: {o.deal_date}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('contact')}: {contactName(o.provider_contact_id)}
                      {' آ· '}
                      {t('receiveRegion')}: {regionLabel(o.attributes?.receive_region_id)} / {methodLabel(o.attributes?.receive_method)}
                      {' آ· '}
                      {t('payRegion')}: {regionLabel(o.attributes?.pay_region_id)} / {methodLabel(o.attributes?.pay_method)}
                    </p>
                    <RowActions kind="offers" row={o} />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : null}

      {/* Requests view */}
      {view === 'requests' ? (
        requests === null ? (
          <Spinner />
        ) : requests.length === 0 ? (
          <Empty label={t('emptyRequests')} />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <Card key={r.id}>
                <CardContent className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Search className="h-4 w-4 text-primary" />
                    <Badge variant="outline">{r.priority}</Badge>
                    <span className="font-mono text-sm">
                      {r.requested_amount} {r.currency}
                    </span>
                    <Badge variant="secondary" className="ms-auto">
                      {statusLabel(r.status)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('contact')}: {contactName(r.requester_contact_id)}
                    {' · '}
                    {t('receiveRegion')}: {regionLabel(r.attributes?.receive_region_id)} / {methodLabel(r.attributes?.receive_method)}
                    {' · '}
                    {t('payRegion')}: {regionLabel(r.attributes?.pay_region_id)} / {methodLabel(r.attributes?.pay_method)}
                    {r.commission_per_thousand ? (
                      <>
                        {' · '}
                        {t('commissionRate')}: {r.commission_per_thousand} ({t('commissionAmount')}: {r.commission_amount} {r.commission_currency})
                      </>
                    ) : null}
                    {' · '}
                    {t('dealDate')}: {r.deal_date}
                  </p>
                  <RowActions kind="requests" row={r} />
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : null}

      {/* Suggestions view */}
      {view === 'suggestions' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('suggestionsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label={t('selectRequest')}>
                <select
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                  value={sRequestId}
                  onChange={(e) => {
                    setSRequestId(e.target.value);
                    void loadSuggestions(e.target.value);
                  }}
                >
                  <option value="">—</option>
                  {bookableRequests.map((r) => (
                    <option key={r.id} value={r.id}>
                      {contactName(r.requester_contact_id)} آ· {r.requested_amount} {r.currency}
                    </option>
                  ))}
                </select>
              </Field>
              {!sRequestId && complementaryPairs.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('complementaryPairs')}</p>
                  <p className="text-xs text-muted-foreground">{t('complementaryHint')}</p>
                  {complementaryPairs.map((pair) => (
                    <div
                      key={`${pair.a_id}-${pair.b_id}`}
                      className="flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{t('matchScore')}: {pair.score}%</span>
                      <code className="font-mono text-xs">
                        {(offers ?? []).find((o) => o.id === pair.a_id)?.reference_code ??
                          contactName((requests ?? []).find((r) => r.id === pair.a_id)?.requester_contact_id)}
                      </code>
                      <span>↔</span>
                      <code className="font-mono text-xs">
                        {(offers ?? []).find((o) => o.id === pair.b_id)?.reference_code ??
                          contactName((requests ?? []).find((r) => r.id === pair.b_id)?.requester_contact_id)}
                      </code>
                      <span className="font-mono text-xs">
                        {pair.amount} {pair.currency}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {suggestions === null ? (
                sRequestId ? <Spinner /> : null
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t('remaining')}: <span className="font-mono">{suggestions.request_remaining} {suggestions.currency}</span>
                    {suggestions.fully_coverable ? (
                      <Badge className="ms-2">{t('coverageRatio')}: 100%</Badge>
                    ) : null}
                  </p>
                  {suggestions.singles.length === 0 && !suggestions.bundle ? (
                    <Empty label={t('emptySuggestions')} />
                  ) : (
                    <div className="space-y-2">
                      {suggestions.singles.map((leg) => (
                        <SuggestionCard
                          key={`${leg.offer_id}-${leg.amount}`}
                          leg={leg}
                          t={t}
                          isBusy={busy === `book:${leg.offer_id}:${leg.request_id}`}
                          onBook={() =>
                            void bookLeg(leg.offer_id, leg.request_id, leg.amount, leg.currency)
                          }
                          offerRef={
                            (offers ?? []).find((o) => o.id === leg.offer_id)?.reference_code
                          }
                          showBook
                        />
                      ))}
                      {suggestions.bundle ? (
                        <Card>
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base">
                              <Layers className="h-4 w-4 text-primary" />
                              {t('bundle')} آ· {t('coverageRatio')}: {Math.round(suggestions.bundle_coverage * 100)}%
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {suggestions.bundle.map((leg) => (
                              <SuggestionCard
                                key={`${leg.offer_id}-${leg.amount}`}
                                leg={leg}
                                t={t}
                                isBusy={busy === `book:${leg.offer_id}:${leg.request_id}`}
                                onBook={() =>
                                  void bookLeg(leg.offer_id, leg.request_id, leg.amount, leg.currency)
                                }
                                offerRef={
                                  (offers ?? []).find((o) => o.id === leg.offer_id)?.reference_code
                                }
                                showBook
                              />
                            ))}
                            <p className="text-sm text-muted-foreground">
                              {t('commissionAmount')}: {suggestions.bundle_commission_amount} {suggestions.currency}
                            </p>
                          </CardContent>
                        </Card>
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Matches view */}
      {view === 'matches' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('reserveTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label={t('offers')}>
                  <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={mOffer} onChange={(e) => setMOffer(e.target.value)}>
                    <option value="">—</option>
                    {bookableOffers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.reference_code} آ· {remaining(o)} {o.currency}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('requests')}>
                  <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={mRequest} onChange={(e) => setMRequest(e.target.value)}>
                    <option value="">—</option>
                    {bookableRequests.filter((r) => r.currency === (activeCurrency ?? r.currency)).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.requested_amount} {r.currency}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('amount')}>
                  <Input value={mAmount} onChange={(e) => setMAmount(e.target.value)} inputMode="decimal" />
                </Field>
              </div>
              <Button onClick={() => void reserveMatch()} disabled={busy === 'match' || !mOffer || !mRequest || !mAmount}>
                {busy === 'match' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <ArrowDownUp className="me-1.5 h-4 w-4" />}
                {t('reserve')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('atomicHint')}</p>
            </CardContent>
          </Card>

          {matches === null ? (
            <Spinner />
          ) : matches.length === 0 ? (
            <Empty label={t('emptyMatches')} />
          ) : (
            <div className="space-y-2">
              {matches.map((m) => {
                const fee = m.fee_snapshot as
                  | { commission_amount?: string; commission_currency?: string; commission_per_thousand?: string }
                  | null;
                return (
                  <Card key={m.id}>
                    <CardContent className="flex flex-wrap items-center gap-2 py-3">
                      <ArrowDownUp className="h-4 w-4 text-primary" />
                      <span className="font-mono text-sm">
                        {m.matched_amount} {m.currency}
                      </span>
                      {fee?.commission_per_thousand ? (
                        <span className="text-xs text-muted-foreground">
                          {t('commissionRate')}: {fee.commission_per_thousand} آ· {t('commissionAmount')}: {fee.commission_amount} {fee.commission_currency}
                        </span>
                      ) : null}
                      <Badge variant={m.status === 'reserved' ? 'default' : 'secondary'}>
                        {m.status}
                      </Badge>
                      <span className="ms-auto text-xs text-muted-foreground">
                        {new Date(m.created_at).toISOString()}
                      </span>
                      {m.status === 'reserved' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === `release:${m.id}`}
                          onClick={() => void releaseMatch(m.id)}
                        >
                          {busy === `release:${m.id}` ? (
                            <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                          ) : (
                            <X className="me-1.5 h-4 w-4" />
                          )}
                          {t('release')}
                        </Button>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function SuggestionCard({
  leg,
  t,
  isBusy,
  onBook,
  offerRef,
  showBook,
}: {
  leg: SuggestionLeg;
  t: ReturnType<typeof useTranslations>;
  isBusy: boolean;
  onBook: () => void;
  offerRef?: string;
  showBook: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm">
      <span className="font-medium">{t('matchScore')}: {leg.score}%</span>
      <Badge variant={leg.orientation === 'mirror' ? 'default' : 'outline'}>
        {leg.orientation === 'mirror' ? t('matchMirror') : t('matchDirect')}
      </Badge>
      <span className="font-mono">
        {leg.amount} {leg.currency}
      </span>
      {offerRef ? <code className="font-mono text-xs">{offerRef}</code> : null}
      {leg.commission_per_thousand ? (
        <span className="text-xs text-muted-foreground">
          {t('commissionRate')}: {leg.commission_per_thousand} â†’ {leg.commission_amount} {leg.commission_currency}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {t('remaining')}: {leg.offer_headroom_after}
      </span>
      {showBook ? (
        <Button
          size="sm"
          className="ms-auto"
          disabled={isBusy}
          onClick={onBook}
        >
          {isBusy ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
          {t('bookLeg')}
        </Button>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading…
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}
