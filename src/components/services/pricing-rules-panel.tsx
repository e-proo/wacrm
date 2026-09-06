'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  Plus,
  Send,
  Pencil,
  Save,
  Activity,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CurrencyDropdown } from './currency-dropdown';

interface PricingRuleRow {
  id: string;
  name: string;
  kind: string;
  fee_currency: string | null;
  input_currency: string | null;
  minimum_fee: string | null;
  maximum_fee: string | null;
  rounding_mode: string | null;
  formula_config: Record<string, unknown>;
  status: 'draft' | 'published' | 'superseded';
  created_at: string;
  published_at: string | null;
}

const RULE_KINDS = [
  'fixed',
  'percentage',
  'per_unit',
  'fixed_plus_percentage',
  'tiered',
  'fx_buy_sell',
  'manual_quote',
] as const

const ROUNDING_MODES = [
  'proportional',
  'ceil_started_unit',
  'floor_complete_unit',
  'nearest_unit',
] as const

const DEFAULT_FORMULA: Record<string, unknown> = {
  fixed: { amount: '' },
  percentage: { percentage: '' },
  per_unit: { unit_size: '', rate_per_unit: '', unit_rounding: 'proportional' },
  fixed_plus_percentage: { fixed: '', percentage: '' },
  tiered: {
    tiers: [{ up_to: '', rate_per_unit: '', unit_size: '1' }],
  },
  fx_buy_sell: { side: 'sell', buy_rate: '', sell_rate: '' },
  manual_quote: {},
}

export function PricingRulesPanel() {
  const t = useTranslations('Services');
  const tRules = useTranslations('Services.rules');
  const [rules, setRules] = useState<PricingRuleRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Editor state (for create + edit).
  const [name, setName] = useState('');
  const [kind, setKind] = useState<typeof RULE_KINDS[number]>('fixed');
  const [feeCurrency, setFeeCurrency] = useState('YER');
  const [inputCurrency, setInputCurrency] = useState('YER');
  const [minimumFee, setMinimumFee] = useState('');
  const [maximumFee, setMaximumFee] = useState('');
  const [roundingMode, setRoundingMode] = useState<typeof ROUNDING_MODES[number] | ''>('');
  const [formulaJson, setFormulaJson] = useState('{}');
  const [formulaError, setFormulaError] = useState<string | null>(null);
  const [tiersExpanded, setTiersExpanded] = useState(false);

  async function load() {
    setError(null);
    const res = await fetch('/api/pricing-rules', { cache: 'no-store' });
    if (!res.ok) {
      setRules([]);
      return;
    }
    const json = (await res.json()) as { rules: PricingRuleRow[] };
    setRules(json.rules ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  // When the kind changes, reset the formula to the matching
  // default shape so the editor doesn't carry over stale keys.
  useEffect(() => {
    const def = DEFAULT_FORMULA[kind]
    setFormulaJson(JSON.stringify(def, null, 2))
    setFormulaError(null)
  }, [kind])

  const selectedRule = rules?.find((r) => r.id === selected) ?? null;

  const fillFromRule = useCallback((r: PricingRuleRow) => {
    setName(r.name)
    setKind(r.kind as typeof RULE_KINDS[number])
    setFeeCurrency(r.fee_currency ?? '')
    setInputCurrency(r.input_currency ?? '')
    setMinimumFee(r.minimum_fee ?? '')
    setMaximumFee(r.maximum_fee ?? '')
    setRoundingMode((r.rounding_mode ?? '') as typeof ROUNDING_MODES[number] | '')
    setFormulaJson(JSON.stringify(r.formula_config ?? {}, null, 2))
    setFormulaError(null)
  }, [])

  async function submit() {
    setBusy('save')
    setError(null)
    setFormulaError(null)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(formulaJson)
    } catch (e) {
      setFormulaError(e instanceof Error ? e.message : 'Invalid JSON')
      setBusy(null)
      return
    }
    const body = {
      name: name.trim(),
      kind,
      feeCurrency: feeCurrency || null,
      inputCurrency: inputCurrency || null,
      minimumFee: minimumFee || null,
      maximumFee: maximumFee || null,
      roundingMode: roundingMode || null,
      formulaConfig: parsed,
    }
    try {
      const res = await fetch(
        selected ? `/api/pricing-rules/${selected}` : '/api/pricing-rules',
        {
          method: selected ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const json = (await res.json()) as {
        rule?: PricingRuleRow
        error?: string
      }
      if (!res.ok || !json.rule) {
        throw new Error(json.error ?? 'Save failed')
      }
      setSelected(json.rule.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setBusy(null)
    }
  }

  async function publish(id: string) {
    setBusy(`publish:${id}`)
    setError(null)
    try {
      const res = await fetch(`/api/pricing-rules/${id}`, { method: 'POST' })
      const json = (await res.json()) as {
        rule?: PricingRuleRow
        error?: string
      }
      if (!res.ok || !json.rule) {
        throw new Error(json.error ?? 'Publish failed')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setBusy(null)
    }
  }

  async function startNew() {
    setSelected(null)
    setName('')
    setKind('fixed')
    setFeeCurrency('YER')
    setInputCurrency('YER')
    setMinimumFee('')
    setMaximumFee('')
    setRoundingMode('')
    setFormulaJson(JSON.stringify(DEFAULT_FORMULA.fixed, null, 2))
    setFormulaError(null)
  }

  if (rules === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* Rules list */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{tRules('rulesTitle')}</h3>
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={() => void startNew()}
          >
            <Plus className="me-1.5 h-4 w-4" /> {tRules('newRule')}
          </Button>
        </div>
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tRules('empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {rules.map((r) => (
              <Card
                key={r.id}
                className={
                  r.id === selected ? 'border-primary' : 'cursor-pointer'
                }
                onClick={() => {
                  setSelected(r.id)
                  fillFromRule(r)
                }}
              >
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge variant="outline">{r.kind}</Badge>
                    <Badge variant="outline" className="ms-auto">
                      {r.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Editor */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {selected ? (
              <Pencil className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {selected ? tRules('editRule') : tRules('newRule')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{tRules('name')}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tRules('namePlaceholder')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{tRules('kind')}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof RULE_KINDS[number])}
                disabled={Boolean(selectedRule && selectedRule.status === 'published')}
              >
                {RULE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {tRules(`kind_${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                {tRules('rounding')}
              </label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={roundingMode}
                onChange={(e) =>
                  setRoundingMode(
                    e.target.value as typeof ROUNDING_MODES[number] | '',
                  )
                }
                disabled={Boolean(selectedRule && selectedRule.status === 'published')}
              >
                <option value="">{tRules('noRounding')}</option>
                {ROUNDING_MODES.map((m) => (
                  <option key={m} value={m}>
                    {tRules(`rounding_${m}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <CurrencyDropdown
                label={tRules('feeCurrency')}
                value={feeCurrency}
                onChange={setFeeCurrency}
                disabled={Boolean(selectedRule && selectedRule.status === 'published')}
              />
            </div>
            <div className="space-y-1">
              <CurrencyDropdown
                label={tRules('inputCurrency')}
                value={inputCurrency}
                onChange={setInputCurrency}
                disabled={Boolean(selectedRule && selectedRule.status === 'published')}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">{tRules('minFee')}</label>
                <Input
                  value={minimumFee}
                  onChange={(e) => setMinimumFee(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">{tRules('maxFee')}</label>
                <Input
                  value={maximumFee}
                  onChange={(e) => setMaximumFee(e.target.value)}
                  inputMode="decimal"
                />
              </div>
            </div>
          </div>

          {/* Formula editor */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">{tRules('formula')}</label>
              {kind === 'tiered' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setTiersExpanded((v) => !v)}
                >
                  {tiersExpanded ? (
                    <ChevronUp className="me-1 h-4 w-4" />
                  ) : (
                    <ChevronDown className="me-1 h-4 w-4" />
                  )}
                  {tRules('tiersHint')}
                </Button>
              ) : null}
            </div>
            <textarea
              className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs"
              rows={tiersExpanded ? 14 : 8}
              value={formulaJson}
              onChange={(e) => setFormulaJson(e.target.value)}
              disabled={Boolean(selectedRule && selectedRule.status === 'published')}
              dir="ltr"
            />
            {formulaError ? (
              <p className="text-xs text-destructive">{formulaError}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void submit()}
              disabled={busy === 'save' || !name.trim() || Boolean(selectedRule && selectedRule.status === 'published')}
            >
              {busy === 'save' ? (
                <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="me-1.5 h-4 w-4" />
              )}
              {selected ? tRules('update') : tRules('create')}
            </Button>
            {selected && selectedRule && selectedRule.status === 'draft' ? (
              <Button
                variant="default"
                onClick={() => void publish(selected)}
                disabled={busy === `publish:${selected}`}
              >
                {busy === `publish:${selected}` ? (
                  <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="me-1.5 h-4 w-4" />
                )}
                {tRules('publish')}
              </Button>
            ) : null}
            {selectedRule && selectedRule.status === 'published' ? (
              <Badge variant="secondary">{tRules('immutable')}</Badge>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Lightweight re-export so other surfaces can use the icon.
export function ActivityIcon({ className }: { className?: string }) {
  return <Activity className={className ?? 'h-4 w-4'} />
}
