'use client';

import { useEffect, useState } from 'react';

export interface CurrencyOption {
  id: string;
  code: string;
  display_name: string;
  symbol: string | null;
  decimal_digits: number;
  kind: 'iso_4217' | 'historical' | 'local';
}

interface CurrencyDropdownProps {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  /** Optional label rendered above the select. */
  label?: string;
  /** Placeholder text when nothing is selected. */
  placeholder?: string;
  /** Whether to fall back to a free-text input alongside the dropdown
   *  for codes the account hasn't catalogued yet. Useful during the
   *  migration period where historical data has codes the new
   *  catalog doesn't (yet). */
  allowCustom?: boolean;
}

/**
 * Fetches the account's ACTIVE currencies once on mount and
 * renders a dropdown. If `allowCustom` is true, the dropdown
 * includes an "Other (type code)…" option that opens a free-
 * text input — this lets existing rows with codes outside the
 * catalog continue to round-trip without a manual fix-up step.
 */
export function CurrencyDropdown({
  value,
  onChange,
  disabled,
  label,
  placeholder = 'Select currency',
  allowCustom = true,
}: CurrencyDropdownProps) {
  const [currencies, setCurrencies] = useState<CurrencyOption[] | null>(null)
  const [usingCustom, setUsingCustom] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/currencies/active', { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) setCurrencies([])
          return
        }
        const json = (await res.json()) as { currencies: CurrencyOption[] }
        if (!cancelled) {
          setCurrencies(json.currencies ?? [])
          // If the current value isn't in the catalog AND we're
          // allowing custom, switch to the free-text mode.
          const known = (json.currencies ?? []).some((c) => c.code === value)
          setUsingCustom(allowCustom && value.length > 0 && !known)
        }
      } catch {
        if (!cancelled) setCurrencies([])
      }
    })()
    return () => {
      cancelled = true
    }
    // We intentionally don't re-run on value changes — the
    // initial pass decides once whether to show the custom
    // input. Subsequent edits via the dropdown or the input
    // flip `usingCustom` explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (currencies === null) {
    return (
      <div className="space-y-1">
        {label ? <label className="text-sm font-medium">{label}</label> : null}
        <div className="h-9 w-full animate-pulse rounded bg-muted" />
      </div>
    )
  }

  if (usingCustom && allowCustom) {
    return (
      <div className="space-y-1">
        {label ? <label className="text-sm font-medium">{label}</label> : null}
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border bg-background px-2 py-1.5 font-mono text-sm"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            placeholder="YER_OLD"
            dir="ltr"
          />
          <button
            type="button"
            className="rounded border px-2 py-1.5 text-xs hover:bg-muted"
            onClick={() => {
              setUsingCustom(false)
              onChange('')
            }}
          >
            ↩
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {label ? <label className="text-sm font-medium">{label}</label> : null}
      <select
        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === '__custom__') {
            setUsingCustom(true)
            onChange('')
          } else {
            onChange(e.target.value)
          }
        }}
      >
        <option value="">{placeholder}</option>
        {currencies.map((c) => (
          <option key={c.id} value={c.code}>
            {c.code}
            {c.symbol && c.symbol !== c.code ? ` (${c.symbol})` : ''}
            {' — '}
            {c.display_name}
          </option>
        ))}
        {allowCustom ? <option value="__custom__">Other (type code)…</option> : null}
      </select>
    </div>
  )
}
