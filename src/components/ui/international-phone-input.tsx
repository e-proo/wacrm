'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'
import { ChevronDown, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface InternationalPhoneInputProps {
  onChange: (e164: string) => void
  defaultCountry?: CountryCode
  disabled?: boolean
}

interface CountryOption {
  code: CountryCode
  name: string
  englishName: string
  callingCode: string
}

function flagEmoji(code: string): string {
  return code
    .toUpperCase()
    .split('')
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('')
}

export function InternationalPhoneInput({
  onChange,
  defaultCountry = 'YE',
  disabled = false,
}: InternationalPhoneInputProps) {
  const locale = useLocale()
  const arabic = locale.toLowerCase().startsWith('ar')
  const [country, setCountry] = useState<CountryCode>(defaultCountry)
  const [nationalNumber, setNationalNumber] = useState('')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [valid, setValid] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const countries = useMemo<CountryOption[]>(() => {
    const names = new Intl.DisplayNames([locale, 'en'], { type: 'region' })
    const englishNames = new Intl.DisplayNames(['en'], { type: 'region' })
    return getCountries()
      .map((code) => ({
        code,
        name: names.of(code) ?? code,
        englishName: englishNames.of(code) ?? code,
        callingCode: getCountryCallingCode(code),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale))
  }, [locale])

  const selected = countries.find((item) => item.code === country)

  const filtered = useMemo(() => {
    const raw = query.trim().toLocaleLowerCase(locale)
    if (!raw) return countries
    const digits = raw.replace(/\D/g, '')
    return countries.filter((item) =>
      item.name.toLocaleLowerCase(locale).includes(raw) ||
      item.englishName.toLowerCase().includes(raw) ||
      item.code.toLowerCase().includes(raw) ||
      (digits.length > 0 && item.callingCode.includes(digits))
    )
  }, [countries, locale, query])

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  function emit(raw: string, targetCountry = country) {
    const digits = raw.replace(/\D/g, '')
    const formatted = digits ? new AsYouType(targetCountry).input(digits) : ''
    setNationalNumber(formatted)
    if (!digits) {
      setValid(false)
      onChange('')
      return
    }
    const parsed = parsePhoneNumberFromString(formatted, targetCountry)
    const isValid = Boolean(parsed?.isValid())
    setValid(isValid)
    onChange(isValid && parsed ? parsed.number : '')
  }

  function choose(nextCountry: CountryCode) {
    setCountry(nextCountry)
    setOpen(false)
    setQuery('')
    emit(nationalNumber, nextCountry)
  }

  const hasEnoughDigits = nationalNumber.replace(/\D/g, '').length >= 4

  return (
    <div ref={rootRef} className="space-y-1.5">
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          className="flex h-10 w-full items-center gap-2 rounded-md border bg-background px-3 text-start text-sm disabled:cursor-not-allowed disabled:opacity-50"
          aria-expanded={open}
        >
          <span aria-hidden>{flagEmoji(country)}</span>
          <span className="min-w-0 flex-1 truncate">{selected?.name ?? country}</span>
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">+{selected?.callingCode}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {open ? (
          <div className="absolute z-50 mt-1 w-full min-w-[290px] rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
            <div className="relative mb-2">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={arabic ? 'ابحث باسم الدولة أو رمز الاتصال مثل 967' : 'Search country or calling code, e.g. 967'}
                className="ps-8"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => choose(item.code)}
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-start text-sm hover:bg-muted"
                >
                  <span aria-hidden>{flagEmoji(item.code)}</span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span dir="ltr" className="font-mono text-xs text-muted-foreground">+{item.callingCode}</span>
                </button>
              ))}
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {arabic ? 'لا توجد دولة مطابقة.' : 'No matching country.'}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring/50">
        <span dir="ltr" className="border-e px-3 font-mono text-sm text-muted-foreground">
          +{selected?.callingCode}
        </span>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          disabled={disabled}
          value={nationalNumber}
          onChange={(event) => emit(event.target.value)}
          placeholder={arabic ? 'اكتب الرقم فقط دون رمز الدولة' : 'Number without country code'}
          className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
          dir="ltr"
        />
      </div>
      {hasEnoughDigits && !valid ? (
        <p className="text-xs text-destructive">
          {arabic ? 'الرقم غير صالح للدولة المحددة.' : 'The number is not valid for the selected country.'}
        </p>
      ) : null}
    </div>
  )
}
