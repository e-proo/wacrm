'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  CheckCircle2,
  AlertCircle,
  History as HistoryIcon,
  Pencil,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { evaluateStaleness } from '@/lib/services/rates/staleness';
import { CurrencyDropdown } from './currency-dropdown';

interface BookRow {
  id: string;
  name: string;
  region: string | null;
  channel: string;
  settlement_method: string | null;
  timezone: string;
  stale_after_seconds: number;
  current_published_version_id: string | null;
  status: string;
}

interface VersionRow {
  id: string;
  book_id: string;
  version_number: number;
  status: 'draft' | 'published' | 'superseded';
  effective_at: string | null;
  expires_at: string | null;
  published_at: string | null;
}

interface RateRow {
  id?: string;
  base_currency: string;
  quote_currency: string;
  buy_rate: string;
  sell_rate: string;
  min_amount: string | null;
  max_amount: string | null;
  rate_unit: string | null;
}

interface ValidateResult {
  ok: boolean;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  duplicate_pairs: Array<{ base: string; quote: string }>;
  non_positive_rates: Array<{
    base: string;
    quote: string;
    side: 'buy' | 'sell';
  }>;
  rate_count: number;
}

interface HistoryRow {
  id: string;
  book_id: string;
  base_currency: string;
  quote_currency: string;
  buy_rate: string | null;
  sell_rate: string | null;
  effective_at: string;
  event_kind: 'created' | 'superseded' | 'expired';
}

export function ExchangeRateBooksPanel() {
  const t = useTranslations('Services');
  const tFx = useTranslations('Services.fx');
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [rates, setRates] = useState<RateRow[] | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateResult | null>(null);

  // Create-book form state.
  const [bookName, setBookName] = useState('');
  const [bookRegion, setBookRegion] = useState('');
  const [bookSettlement, setBookSettlement] = useState<'cash' | 'bank' | 'wallet' | 'other' | ''>(
    'cash',
  );
  const [bookStale, setBookStale] = useState('1800');

  // Rate editor state.
  const [editorRates, setEditorRates] = useState<RateRow[]>([]);

  const loadBooks = useCallback(async () => {
    setError(null);
    const res = await fetch('/api/exchange-rate-books', { cache: 'no-store' });
    if (!res.ok) {
      setBooks([]);
      return;
    }
    const json = (await res.json()) as { books: BookRow[] };
    setBooks(json.books ?? []);
    if (!selectedBookId && json.books?.[0]) {
      setSelectedBookId(json.books[0].id);
    }
  }, [selectedBookId]);

  const loadVersions = useCallback(
    async (bookId: string) => {
      setError(null);
      const res = await fetch(
        `/api/exchange-rate-books/${bookId}/versions`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        setVersions([]);
        return;
      }
      const json = (await res.json()) as { versions: VersionRow[] };
      setVersions(json.versions ?? []);
    },
    [],
  );

  const loadRates = useCallback(async (versionId: string) => {
    setError(null);
    const [ratesRes, historyRes] = await Promise.all([
      fetch(
        `/api/exchange-rate-books/${selectedBookId}/versions/${versionId}/rates`,
        { cache: 'no-store' },
      ),
      fetch(`/api/exchange-rate-history?bookId=${selectedBookId}`, {
        cache: 'no-store',
      }),
    ]);
    if (ratesRes.ok) {
      const json = (await ratesRes.json()) as { rates: RateRow[] };
      setRates(json.rates ?? []);
      setEditorRates(json.rates ?? []);
    } else {
      setRates([]);
      setEditorRates([]);
    }
    if (historyRes.ok) {
      const json = (await historyRes.json()) as { history: HistoryRow[] };
      setHistory(json.history ?? []);
    } else {
      setHistory([]);
    }
    setValidation(null);
  }, [selectedBookId]);

  useEffect(() => {
    void loadBooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedBookId) return;
    void loadVersions(selectedBookId);
    setSelectedVersionId(null);
    setRates(null);
    setEditorRates([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBookId]);

  useEffect(() => {
    if (!selectedVersionId) return;
    void loadRates(selectedVersionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId]);

  async function createBook() {
    setError(null);
    setBusy('createBook');
    try {
      const res = await fetch('/api/exchange-rate-books', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bookName,
          region: bookRegion || null,
          settlementMethod: bookSettlement || null,
          staleAfterSeconds: Number(bookStale) || 1800,
        }),
      });
      const json = (await res.json()) as {
        book?: BookRow;
        error?: string;
      };
      if (!res.ok || !json.book) {
        throw new Error(json.error ?? 'Create failed');
      }
      setBookName('');
      setBookRegion('');
      setBookSettlement('cash');
      setBookStale('1800');
      await loadBooks();
      setSelectedBookId(json.book.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function createDraftVersion() {
    if (!selectedBookId) return;
    setBusy('createVersion');
    setError(null);
    try {
      const res = await fetch(
        `/api/exchange-rate-books/${selectedBookId}/versions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const json = (await res.json()) as {
        version?: VersionRow;
        error?: string;
      };
      if (!res.ok || !json.version) {
        throw new Error(json.error ?? 'Create version failed');
      }
      await loadVersions(selectedBookId);
      setSelectedVersionId(json.version.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function saveRates() {
    if (!selectedBookId || !selectedVersionId) return;
    setBusy('saveRates');
    setError(null);
    try {
      const res = await fetch(
        `/api/exchange-rate-books/${selectedBookId}/versions/${selectedVersionId}/rates`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rates: editorRates }),
        },
      );
      const json = (await res.json()) as {
        rates?: RateRow[];
        error?: string;
      };
      if (!res.ok || !json.rates) {
        throw new Error(json.error ?? 'Save failed');
      }
      setRates(json.rates);
      await loadRates(selectedVersionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function validateRates() {
    if (!selectedBookId || !selectedVersionId) return;
    setBusy('validate');
    setError(null);
    try {
      const res = await fetch(
        `/api/exchange-rate-books/${selectedBookId}/versions/${selectedVersionId}/validate`,
        { method: 'POST' },
      );
      const json = (await res.json()) as ValidateResult;
      setValidation(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  async function publishVersion() {
    if (!selectedBookId || !selectedVersionId) return;
    setBusy('publish');
    setError(null);
    try {
      const res = await fetch(
        `/api/exchange-rate-books/${selectedBookId}/publish`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ versionId: selectedVersionId }),
        },
      );
      const json = (await res.json()) as {
        versionId?: string;
        error?: string;
      };
      if (!res.ok || !json.versionId) {
        throw new Error(json.error ?? 'Publish failed');
      }
      await loadBooks();
      await loadVersions(selectedBookId);
      await loadRates(selectedVersionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  function addRateRow() {
    setEditorRates((prev) => [
      ...prev,
      {
        base_currency: '',
        quote_currency: '',
        buy_rate: '',
        sell_rate: '',
        min_amount: null,
        max_amount: null,
        rate_unit: null,
      },
    ]);
  }

  function updateRateRow(idx: number, patch: Partial<RateRow>) {
    setEditorRates((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  function removeRateRow(idx: number) {
    setEditorRates((prev) => prev.filter((_, i) => i !== idx));
  }

  if (books === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;
  const selectedVersion =
    versions.find((v) => v.id === selectedVersionId) ?? null;

  // Compute staleness badge for the current live version.
  const liveVersion = versions.find(
    (v) => v.id === selectedBook?.current_published_version_id,
  );
  const staleness = liveVersion
    ? evaluateStaleness(
        {
          effective_at: liveVersion.effective_at,
          expires_at: liveVersion.expires_at,
          published_at: liveVersion.published_at,
          stale_after_seconds: selectedBook?.stale_after_seconds ?? 1800,
        },
        new Date(),
      )
    : null;

  return (
    <div className="space-y-6">
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* Create-book form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tFx('addBook')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{tFx('name')}</label>
              <Input
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
                placeholder={tFx('namePlaceholder')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tFx('region')}</label>
              <Input
                value={bookRegion}
                onChange={(e) => setBookRegion(e.target.value)}
                placeholder="Sanaa"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {tFx('settlement')}
              </label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={bookSettlement}
                onChange={(e) =>
                  setBookSettlement(
                    e.target.value as typeof bookSettlement,
                  )
                }
              >
                <option value="cash">{tFx('cash')}</option>
                <option value="bank">{tFx('bank')}</option>
                <option value="wallet">{tFx('wallet')}</option>
                <option value="other">{tFx('other')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tFx('stale')}</label>
              <Input
                value={bookStale}
                onChange={(e) => setBookStale(e.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>
          <Button
            onClick={() => void createBook()}
            disabled={busy === 'createBook' || !bookName.trim()}
          >
            {busy === 'createBook' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="me-1.5 h-4 w-4" />
            )}
            {tFx('createBook')}
          </Button>
        </CardContent>
      </Card>

      {/* Book list */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{tFx('booksTitle')}</h3>
        {books.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tFx('empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {books.map((b) => (
              <Card
                key={b.id}
                className={
                  b.id === selectedBookId
                    ? 'border-primary'
                    : 'cursor-pointer'
                }
                onClick={() => setSelectedBookId(b.id)}
              >
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{b.name}</span>
                    <Badge variant="outline">{b.channel}</Badge>
                    {b.region ? (
                      <Badge variant="secondary">{b.region}</Badge>
                    ) : null}
                    {b.settlement_method ? (
                      <Badge variant="secondary">
                        {b.settlement_method}
                      </Badge>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Live version staleness badge */}
      {selectedBook && liveVersion && staleness ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {tFx('liveVersion')} #{liveVersion.version_number}:
          </span>
          {staleness.isStale ? (
            <Badge variant="destructive">{tFx('stale')}</Badge>
          ) : (
            <Badge variant="default" className="bg-emerald-500/20 text-emerald-300">
              {tFx('current')}
            </Badge>
          )}
          {!staleness.isStale && staleness.secondsUntilStale !== null ? (
            <span className="text-xs text-muted-foreground">
              {Math.floor(staleness.secondsUntilStale / 60)}{' '}
              {tFx('minutesRemaining')}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Versions list */}
      {selectedBook ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span>{tFx('versionsTitle')}</span>
              <Button
                size="sm"
                variant="outline"
                className="ms-auto"
                onClick={() => void createDraftVersion()}
                disabled={busy === 'createVersion'}
              >
                {busy === 'createVersion' ? (
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="me-1.5 h-4 w-4" />
                )}
                {tFx('newVersion')}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tFx('empty')}</p>
            ) : (
              <div className="space-y-1">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded border px-3 py-2 text-start text-sm transition-colors ${
                      v.id === selectedVersionId
                        ? 'border-primary bg-primary/10'
                        : 'hover:bg-muted/40'
                    }`}
                    onClick={() => setSelectedVersionId(v.id)}
                  >
                    <code className="font-mono">#{v.version_number}</code>
                    <Badge variant="outline">{v.status}</Badge>
                    {v.effective_at ? (
                      <span className="text-xs text-muted-foreground">
                        {new Date(v.effective_at).toISOString()}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Rate editor */}
      {selectedVersion ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Pencil className="h-4 w-4" />
              {tFx('ratesTitle')} (#{selectedVersion.version_number})
              {selectedVersion.status === 'draft' ? (
                <Badge variant="outline" className="ms-auto">
                  {tFx('editable')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="ms-auto">
                  {tFx('immutable')}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rates === null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : selectedVersion.status !== 'draft' ? (
              <p className="text-sm text-muted-foreground">
                {tFx('immutableHint')}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {editorRates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {tFx('noRates')}
                    </p>
                  ) : (
                    editorRates.map((r, idx) => (
                      <div
                        key={idx}
                        className="grid grid-cols-1 gap-2 rounded border p-3 md:grid-cols-7"
                      >
                        <CurrencyDropdown
                          label="BASE"
                          value={r.base_currency}
                          onChange={(code) =>
                            updateRateRow(idx, { base_currency: code })
                          }
                          disabled={Boolean(selectedVersion && selectedVersion.status !== 'draft')}
                        />
                        <CurrencyDropdown
                          label="QUOTE"
                          value={r.quote_currency}
                          onChange={(code) =>
                            updateRateRow(idx, { quote_currency: code })
                          }
                          disabled={Boolean(selectedVersion && selectedVersion.status !== 'draft')}
                        />
                        <Input
                          placeholder={tFx('buy')}
                          value={r.buy_rate}
                          onChange={(e) =>
                            updateRateRow(idx, { buy_rate: e.target.value })
                          }
                          inputMode="decimal"
                        />
                        <Input
                          placeholder={tFx('sell')}
                          value={r.sell_rate}
                          onChange={(e) =>
                            updateRateRow(idx, { sell_rate: e.target.value })
                          }
                          inputMode="decimal"
                        />
                        <Input
                          placeholder={tFx('min')}
                          value={r.min_amount ?? ''}
                          onChange={(e) =>
                            updateRateRow(idx, {
                              min_amount: e.target.value || null,
                            })
                          }
                          inputMode="decimal"
                        />
                        <Input
                          placeholder={tFx('max')}
                          value={r.max_amount ?? ''}
                          onChange={(e) =>
                            updateRateRow(idx, {
                              max_amount: e.target.value || null,
                            })
                          }
                          inputMode="decimal"
                        />
                        <Button
                          variant="outline"
                          onClick={() => removeRateRow(idx)}
                        >
                          {tFx('remove')}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={addRateRow}
                  >
                    <Plus className="me-1.5 h-4 w-4" />
                    {tFx('addRate')}
                  </Button>
                  <Button
                    onClick={() => void saveRates()}
                    disabled={busy === 'saveRates'}
                  >
                    {busy === 'saveRates' ? (
                      <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="me-1.5 h-4 w-4" />
                    )}
                    {tFx('saveRates')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void validateRates()}
                    disabled={busy === 'validate'}
                  >
                    <AlertCircle className="me-1.5 h-4 w-4" />
                    {tFx('validate')}
                  </Button>
                  <Button
                    variant="default"
                    onClick={() => void publishVersion()}
                    disabled={busy === 'publish'}
                  >
                    {busy === 'publish' ? (
                      <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="me-1.5 h-4 w-4" />
                    )}
                    {tFx('publish')}
                  </Button>
                </div>

                {validation ? (
                  <div
                    className={`rounded border p-3 text-sm ${
                      validation.ok
                        ? 'border-emerald-500/40 bg-emerald-500/5'
                        : 'border-destructive/40 bg-destructive/5'
                    }`}
                  >
                    {validation.ok ? (
                      <p>{tFx('validationOk')}</p>
                    ) : (
                      <p>
                        {tFx('validationFailed', {
                          errors: validation.errors.length,
                        })}
                      </p>
                    )}
                    {validation.errors.length > 0 ? (
                      <ul className="mt-1 list-disc ps-5 text-xs">
                        {validation.errors.map((e, i) => (
                          <li key={i}>
                            <code>{e.code}</code>: {e.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {validation.warnings.length > 0 ? (
                      <ul className="mt-1 list-disc ps-5 text-xs text-muted-foreground">
                        {validation.warnings.map((w, i) => (
                          <li key={i}>
                            <code>{w.code}</code>: {w.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* History viewer */}
      {selectedBook ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HistoryIcon className="h-4 w-4" />
              {tFx('historyTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {history === null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tFx('empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1">{tFx('effectiveAt')}</th>
                      <th className="px-2 py-1">{tFx('pair')}</th>
                      <th className="px-2 py-1">{tFx('buy')}</th>
                      <th className="px-2 py-1">{tFx('sell')}</th>
                      <th className="px-2 py-1">{tFx('eventKind')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-t">
                        <td className="px-2 py-2 font-mono text-xs">
                          {new Date(h.effective_at).toISOString()}
                        </td>
                        <td className="px-2 py-2 font-mono">
                          {h.base_currency}/{h.quote_currency}
                        </td>
                        <td className="px-2 py-2">{h.buy_rate ?? '—'}</td>
                        <td className="px-2 py-2">{h.sell_rate ?? '—'}</td>
                        <td className="px-2 py-2">
                          <Badge
                            variant={
                              h.event_kind === 'created'
                                ? 'default'
                                : 'secondary'
                            }
                          >
                            {h.event_kind}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
