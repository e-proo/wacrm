'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  Coins,
  Power,
  PowerOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface CurrencyRow {
  id: string;
  code: string;
  display_name: string;
  notes: string | null;
  status: 'active' | 'disabled';
  kind: 'iso_4217' | 'historical' | 'local';
  decimal_digits: number;
  symbol: string | null;
  created_at: string;
}

export function CurrenciesPanel() {
  const t = useTranslations('Services');
  const tCur = useTranslations('Services.currencies');
  const [currencies, setCurrencies] = useState<CurrencyRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create-form state.
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'iso_4217' | 'historical' | 'local'>('iso_4217');
  const [symbol, setSymbol] = useState('');
  const [decimalDigits, setDecimalDigits] = useState('2');
  const [notes, setNotes] = useState('');

  async function load() {
    setError(null);
    const res = await fetch('/api/currencies', { cache: 'no-store' });
    if (!res.ok) {
      setCurrencies([]);
      return;
    }
    const json = (await res.json()) as { currencies: CurrencyRow[] };
    setCurrencies(json.currencies ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy('create');
    setError(null);
    try {
      const res = await fetch('/api/currencies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: code.toUpperCase(),
          displayName,
          notes: notes || null,
          kind,
          symbol: symbol || null,
          decimalDigits: Number(decimalDigits) || 2,
        }),
      });
      const json = (await res.json()) as {
        currency?: CurrencyRow;
        error?: string;
      };
      if (!res.ok || !json.currency) {
        throw new Error(json.error ?? 'Create failed');
      }
      setCode('');
      setDisplayName('');
      setKind('iso_4217');
      setSymbol('');
      setDecimalDigits('2');
      setNotes('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  }

  const toggleStatus = useCallback(
    async (c: CurrencyRow) => {
      const next = c.status === 'active' ? 'disabled' : 'active'
      setBusy(`toggle:${c.id}`)
      setError(null)
      try {
        const res = await fetch(`/api/currencies/${c.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        })
        const json = (await res.json()) as {
          currency?: CurrencyRow
          error?: string
        }
        if (!res.ok || !json.currency) {
          throw new Error(json.error ?? 'Toggle failed')
        }
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  if (currencies === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* Create form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" />
            {tCur('addCurrency')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{tCur('code')}</label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="EUR"
              />
              <p className="text-xs text-muted-foreground">
                {tCur('codeHint')}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tCur('name')}</label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Euro"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tCur('kind')}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as typeof kind)
                }
              >
                <option value="iso_4217">{tCur('kindIso')}</option>
                <option value="historical">{tCur('kindHistorical')}</option>
                <option value="local">{tCur('kindLocal')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tCur('symbol')}</label>
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="€"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tCur('decimalDigits')}</label>
              <Input
                value={decimalDigits}
                onChange={(e) => setDecimalDigits(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1 md:col-span-3">
              <label className="text-sm font-medium">{tCur('notes')}</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={tCur('notesPlaceholder')}
              />
            </div>
          </div>
          <Button
            onClick={() => void create()}
            disabled={
              busy === 'create' ||
              !code.trim() ||
              !displayName.trim()
            }
          >
            {busy === 'create' ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="me-1.5 h-4 w-4" />
            )}
            {tCur('create')}
          </Button>
        </CardContent>
      </Card>

      {/* List */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{tCur('currenciesTitle')}</h3>
        {currencies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tCur('empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {currencies.map((c) => (
              <Card key={c.id}>
                <CardContent className="space-y-2 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg font-bold">
                      {c.code}
                    </span>
                    <Badge
                      variant={c.status === 'active' ? 'default' : 'secondary'}
                    >
                      {c.status === 'active'
                        ? tCur('statusActive')
                        : tCur('statusDisabled')}
                    </Badge>
                    <Badge variant="outline" className="ms-auto">
                      {c.kind === 'iso_4217'
                        ? tCur('kindIso')
                        : c.kind === 'historical'
                          ? tCur('kindHistorical')
                          : tCur('kindLocal')}
                    </Badge>
                  </div>
                  <div className="text-sm">{c.display_name}</div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {c.symbol ? (
                      <span>{tCur('symbol')}: {c.symbol}</span>
                    ) : null}
                    <span>
                      {tCur('decimalDigits')}: {c.decimal_digits}
                    </span>
                  </div>
                  {c.notes ? (
                    <p className="text-xs text-muted-foreground">
                      {c.notes}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `toggle:${c.id}`}
                      onClick={() => void toggleStatus(c)}
                    >
                      {busy === `toggle:${c.id}` ? (
                        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                      ) : c.status === 'active' ? (
                        <PowerOff className="me-1.5 h-4 w-4" />
                      ) : (
                        <Power className="me-1.5 h-4 w-4" />
                      )}
                      {c.status === 'active'
                        ? tCur('disable')
                        : tCur('enable')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
