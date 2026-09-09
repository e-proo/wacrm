'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDownUp,
  Handshake,
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
// Coverage marketplace panel (Phase: coverage UI).
//
// Three sub-views over the Phase 2 APIs:
//   Offers   — liquidity a provider contact supplies.
//   Requests — liquidity a requester contact needs.
//   Matches  — atomic reservations linking an offer to a request.
//
// Reservation and release go through the deterministic SQL RPCs
// (reserve/release_coverage_match), so two operators racing for
// the last unit can never overbook.
// ============================================================

interface OfferRow {
  id: string;
  service_id: string;
  provider_contact_id: string;
  reference_code: string;
  total_amount: string;
  reserved_amount: string;
  fulfilled_amount: string;
  currency: string;
  attributes: Record<string, unknown>;
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
  attributes: Record<string, unknown>;
  priority: string;
  status: string;
}

interface MatchRow {
  id: string;
  offer_id: string;
  request_id: string;
  matched_amount: string;
  currency: string;
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

type View = 'offers' | 'requests' | 'matches';

export function CoveragePanel() {
  const t = useTranslations('Coverage');
  const [view, setView] = useState<View>('offers');
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Create-offer form.
  const [oContact, setOContact] = useState('');
  const [oService, setOService] = useState('');
  const [oAmount, setOAmount] = useState('');
  const [oCurrency, setOCurrency] = useState('YER');
  const [oRef, setORef] = useState('');

  // Create-request form.
  const [rContact, setRContact] = useState('');
  const [rService, setRService] = useState('');
  const [rAmount, setRAmount] = useState('');
  const [rCurrency, setRCurrency] = useState('YER');
  const [rPriority, setRPriority] = useState<'low' | 'normal' | 'high'>('normal');

  // Match form.
  const [mOffer, setMOffer] = useState('');
  const [mRequest, setMRequest] = useState('');
  const [mAmount, setMAmount] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const [o, r, m, c, s] = await Promise.all([
      fetch('/api/coverage/offers', { cache: 'no-store' }),
      fetch('/api/coverage/requests', { cache: 'no-store' }),
      fetch('/api/coverage/matches', { cache: 'no-store' }).catch(() => null),
      fetch('/api/contacts-lite', { cache: 'no-store' }).catch(() => null),
      fetch('/api/services', { cache: 'no-store' }),
    ]);
    setOffers(o.ok ? (await o.json()).offers ?? [] : []);
    setRequests(r.ok ? (await r.json()).requests ?? [] : []);
    setMatches(m && m.ok ? (await m.json()).matches ?? [] : []);
    setContacts(c && c.ok ? (await c.json()).contacts ?? [] : []);
    setServices(s.ok ? (await s.json()).services ?? [] : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createOffer() {
    setBusy('offer');
    setError(null);
    try {
      const res = await fetch('/api/coverage/offers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId: oService,
          providerContactId: oContact,
          referenceCode: oRef || `OFF-${Date.now()}`,
          totalAmount: oAmount,
          currency: oCurrency,
        }),
      });
      const json = (await res.json()) as { offer?: OfferRow; error?: string };
      if (!res.ok || !json.offer) throw new Error(json.error ?? 'Create failed');
      setShowForm(false);
      setOAmount('');
      setORef('');
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
          serviceId: rService,
          requesterContactId: rContact,
          requestedAmount: rAmount,
          currency: rCurrency,
          priority: rPriority,
        }),
      });
      const json = (await res.json()) as { request?: RequestRow; error?: string };
      if (!res.ok || !json.request) throw new Error(json.error ?? 'Create failed');
      setShowForm(false);
      setRAmount('');
      await load();
      setView('requests');
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

  return (
    <div className="space-y-5">
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
          variant={view === 'matches' ? 'default' : 'outline'}
          onClick={() => setView('matches')}
        >
          <ArrowDownUp className="me-1.5 h-4 w-4" /> {t('matches')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ms-auto"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? <X className="me-1.5 h-4 w-4" /> : <Plus className="me-1.5 h-4 w-4" />}
          {t('new')}
        </Button>
      </div>

      {/* Create forms */}
      {showForm && view === 'offers' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('newOffer')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={t('contact')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={oContact} onChange={(e) => setOContact(e.target.value)}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone}</option>)}
                </select>
              </Field>
              <Field label={t('service')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={oService} onChange={(e) => setOService(e.target.value)}>
                  <option value="">—</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label={t('reference')}>
                <Input value={oRef} onChange={(e) => setORef(e.target.value)} placeholder="OFF-1" />
              </Field>
              <Field label={t('amount')}>
                <Input value={oAmount} onChange={(e) => setOAmount(e.target.value)} inputMode="decimal" />
              </Field>
              <Field label={t('currency')}>
                <Input value={oCurrency} onChange={(e) => setOCurrency(e.target.value.toUpperCase())} />
              </Field>
            </div>
            <Button onClick={() => void createOffer()} disabled={busy === 'offer' || !oContact || !oService || !oAmount}>
              {busy === 'offer' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Plus className="me-1.5 h-4 w-4" />}
              {t('create')}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {showForm && view === 'requests' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('newRequest')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={t('contact')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={rContact} onChange={(e) => setRContact(e.target.value)}>
                  <option value="">—</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone}</option>)}
                </select>
              </Field>
              <Field label={t('service')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={rService} onChange={(e) => setRService(e.target.value)}>
                  <option value="">—</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label={t('priority')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={rPriority} onChange={(e) => setRPriority(e.target.value as typeof rPriority)}>
                  <option value="low">{t('low')}</option>
                  <option value="normal">{t('normal')}</option>
                  <option value="high">{t('high')}</option>
                </select>
              </Field>
              <Field label={t('amount')}>
                <Input value={rAmount} onChange={(e) => setRAmount(e.target.value)} inputMode="decimal" />
              </Field>
              <Field label={t('currency')}>
                <Input value={rCurrency} onChange={(e) => setRCurrency(e.target.value.toUpperCase())} />
              </Field>
            </div>
            <Button onClick={() => void createRequest()} disabled={busy === 'request' || !rContact || !rService || !rAmount}>
              {busy === 'request' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Plus className="me-1.5 h-4 w-4" />}
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
                      <Badge variant="outline">{o.status}</Badge>
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
                    </p>
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
                <CardContent className="flex flex-wrap items-center gap-2 py-3">
                  <Search className="h-4 w-4 text-primary" />
                  <Badge variant="outline">{r.priority}</Badge>
                  <span className="font-mono text-sm">
                    {r.requested_amount} {r.currency}
                  </span>
                  <Badge variant="secondary" className="ms-auto">
                    {r.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )
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
                <Field label={t('offer')}>
                  <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={mOffer} onChange={(e) => setMOffer(e.target.value)}>
                    <option value="">—</option>
                    {bookableOffers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.reference_code} · {remaining(o)} {o.currency}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('request')}>
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
              {matches.map((m) => (
                <Card key={m.id}>
                  <CardContent className="flex flex-wrap items-center gap-2 py-3">
                    <ArrowDownUp className="h-4 w-4 text-primary" />
                    <span className="font-mono text-sm">
                      {m.matched_amount} {m.currency}
                    </span>
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
              ))}
            </div>
          )}
        </>
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
