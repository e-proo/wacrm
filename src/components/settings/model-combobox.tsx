'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronsUpDown, Loader2, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ModelInfo } from '@/lib/ai/providers/model-types';

export interface CatalogState {
  models: ModelInfo[];
  fetchedAt: string | null;
  stale: boolean;
  errorCode: string | null; // AI_MODEL_DISCOVERY_UNSUPPORTED etc.
}

interface ModelComboBoxProps {
  id: string;
  /** Optional accessible name for the suggestion list (the field label
   *  itself is rendered by the caller's <Label htmlFor={id}>). */
  label?: string;
  value: string;
  onChange: (v: string) => void;
  catalog: CatalogState | null;
  /** Explicit user action only — never runs on render. */
  onRefresh?: () => void;
  refreshing?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Capability filter: options advertising this capability are kept
   *  unless they're officially 'unsupported'. `unknown` always passes —
   *  absence of metadata is NEVER treated as denial (ADR-005). */
  capability?: 'chat' | 'embeddings';
}

/**
 * Searchable model picker over the normalized catalog with a MANUAL
 * ID as a first-class equal citizen (ADR-004):
 *  - refresh NEVER changes the current selection;
 *  - a saved/entered model missing from the latest catalog stays
 *    visible and selected with a hint, it is never auto-wiped;
 *  - ARIA 1.2 combobox pattern (type-ahead input + listbox popup),
 *    styled with the project's popover surface so it matches the
 *    Base-UI `<Select>` dropdowns everywhere else in Settings.
 */
export function ModelComboBox({
  id,
  label,
  value,
  onChange,
  catalog,
  onRefresh,
  refreshing,
  disabled,
  placeholder,
  capability,
}: ModelComboBoxProps) {
  const t = useTranslations('Settings.aiConnections');
  // Draft = what's typed right now; null means "show the committed
  // selection". Committed value always renders when not typing, so an
  // external change (restore saved model) can never be shadowed.
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const display = draft ?? value;
  const query = draft ?? '';

  const options = useMemo(() => {
    if (!catalog?.models.length) return [];
    const list = capability
      ? catalog.models.filter((m) => m.capabilities[capability] !== 'unsupported')
      : catalog.models;
    const q = query.trim().toLowerCase();
    return (
      q
        ? list.filter(
            (m) =>
              m.id.toLowerCase().includes(q) ||
              (m.displayName ?? '').toLowerCase().includes(q),
          )
        : list
    ).slice(0, 50);
  }, [catalog, query, capability]);

  const missingFromCatalog =
    !!value &&
    !!catalog &&
    catalog.models.length > 0 &&
    !catalog.models.some((m) => m.id === value);

  // Human name of the current selection (when the catalog knows it) so
  // the field never looks like raw API identifiers even while collapsed.
  const resolvedSelected = catalog?.models.find((m) => m.id === value);
  const selectedDisplayName =
    resolvedSelected?.displayName && resolvedSelected.displayName !== value
      ? resolvedSelected.displayName
      : null;

  const pick = (m: ModelInfo) => {
    onChange(m.id);
    setDraft(null);
    setActive(-1);
    setOpen(false);
    inputRef.current?.focus();
  };

  // The list opens when there is something to show; an empty no-matches
  // hint only appears once the user has typed into a non-empty catalog.
  const noMatches =
    open && !!query.trim() && options.length === 0 && (catalog?.models.length ?? 0) > 0;
  const showList = open && !disabled && (options.length > 0 || noMatches);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      if (!showList) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
    } else if (e.key === 'Enter') {
      if (showList && active >= 0 && options[active]) {
        e.preventDefault();
        pick(options[active]);
      } else {
        // Enter with no highlight commits the manual entry as-is.
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  const listId = `${id}-models`;

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={showList}
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              showList && active >= 0 && options[active] ? `${listId}-${active}` : undefined
            }
            value={display}
            onChange={(e) => {
              const v = e.target.value;
              // An edit that lands exactly on a known id (paste) commits
              // it; anything else stays a live draft / manual entry.
              const exact = catalog?.models.find((m) => m.id === v);
              if (exact) {
                onChange(exact.id);
                setDraft(null);
              } else {
                setDraft(v);
                onChange(v); // manual entry stays fully valid
              }
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => !disabled && setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setDraft(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? t('modelManualPlaceholder')}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            className="pe-8"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onPointerDown={(e) => {
              // preventDefault keeps the input focused so blur never
              // closes the list before the click registers.
              e.preventDefault();
              if (showList) {
                setOpen(false);
              } else {
                setOpen(true);
                inputRef.current?.focus();
              }
            }}
            className="absolute end-0 top-0 flex h-full w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
          </button>

          {showList && (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="absolute inset-x-0 z-50 mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              {options.map((m, i) => {
                const friendly =
                  m.displayName && m.displayName !== m.id ? m.displayName : null;
                return (
                  <li
                    key={m.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={m.id === value}
                    title={m.id}
                    // mousedown + preventDefault: select before blur fires
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(m);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{friendly ?? m.id}</span>
                      {friendly && (
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {m.id}
                        </span>
                      )}
                    </span>
                    {m.id === value && (
                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
              {noMatches && (
                <li className="px-1.5 py-1 text-xs text-muted-foreground">
                  {t('modelManualHint')}
                </li>
              )}
            </ul>
          )}
        </div>
        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={disabled || refreshing}
            aria-label={t('refreshCatalog')}
            title={t('refreshCatalog')}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {selectedDisplayName && (
        <p className="truncate text-xs font-medium text-foreground">
          {selectedDisplayName}
        </p>
      )}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {missingFromCatalog
          ? t('savedNotInCatalog')
          : catalog
            ? catalog.stale
              ? t('catalogStale')
              : catalog.fetchedAt
                ? t('catalogFresh', { at: catalog.fetchedAt })
                : catalog.errorCode
                  ? t('catalogUnavailable')
                  : ''
            : t('modelManualHint')}
      </p>
    </div>
  );
}
