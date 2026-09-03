"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
  dirForLocale,
  isLocale,
} from "@/lib/locale";

/**
 * LocaleProvider — owns the active UI language on the client, mirroring
 * the shape of ThemeProvider (use-theme.tsx).
 *
 * next-intl reads its message catalogue on the *server*, keyed off the
 * `wacrm.locale` cookie (see src/i18n/request.ts). Switching language
 * therefore needs a server round-trip — we persist the choice and ask
 * Next.js to re-render the route with the new locale.
 *
 * We use `router.refresh()` instead of `window.location.reload()` so the
 * transition is a soft re-render: the server re-evaluates the cookie,
 * the layout re-renders with the new `dir` / `lang` / messages, and
 * React reconciles in place. No full-page flash, no premature `dir`
 * flip on the still-old content (which would otherwise animate the
 * sidebar's transform from -100% to +100% across the viewport).
 *
 * The boot script in layout.tsx already applied the right `lang`/`dir`
 * before first paint, so there's no flash on the *initial* load either.
 */

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
};

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

/** Reflect a locale on <html> — used on mount and on user-driven changes. */
function applyDirToHtml(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = dirForLocale(locale);
}

/** Persist a locale to localStorage + cookie (no DOM mutation). */
function persistLocale(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts;
    // the cookie below is what the server actually reads, so this is
    // best-effort device memory only.
  }

  document.cookie = [
    `${LOCALE_STORAGE_KEY}=${locale}`,
    "path=/",
    "max-age=31536000",
    "SameSite=Lax",
  ].join("; ");
}

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

type LocaleProviderProps = {
  children: ReactNode;
  /** Locale resolved on the server (from the cookie / env). */
  initialLocale?: Locale;
};

export function LocaleProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: LocaleProviderProps) {
  const router = useRouter();

  // Lazy initializer mirrors ThemeProvider's readInitialTheme: read the
  // device's stored locale at first render instead of reconciling in an
  // effect (setState-in-effect triggers cascading renders). The cookie
  // and localStorage are always written together by persistLocale, so
  // on a normal hydration the stored value equals the server-resolved
  // one. On the server, readStoredLocale falls back to null →
  // initialLocale.
  const [locale, setLocaleState] = useState<Locale>(
    () => readStoredLocale() ?? initialLocale,
  );

  // After the server re-renders the layout with a new locale, the
  // `initialLocale` prop arrives with the new value. Sync our local
  // state so consumers (e.g. LocaleToggle) reflect it. `applyDirToHtml`
  // is also called here as a safety net — the server re-render normally
  // updates <html dir> itself, but this guarantees the attribute is
  // correct even if the server response is cached.
  useEffect(() => {
    if (initialLocale !== locale) {
      setLocaleState(initialLocale);
    }
    applyDirToHtml(initialLocale);
    // We intentionally watch `initialLocale` only — `locale` is the
    // derived value we're syncing toward it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLocale]);

  // Side effect only — no state writes — so future SSR renders agree
  // with this device's choice. The boot script already applied
  // lang/dir before first paint; this keeps the cookie authoritative.
  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  const setLocale = useCallback(
    (nextLocale: Locale) => {
      // 1. Persist the choice (cookie + localStorage). The cookie is
      //    what the server reads on the refresh below.
      persistLocale(nextLocale);
      setLocaleState(nextLocale);

      // 2. Ask Next.js to re-render the route with the new cookie.
      //    The root layout re-renders with the matching `lang` /
      //    `dir` and messages; React reconciles in place. We
      //    intentionally do NOT flip <html dir> here — the server
      //    delivers the new direction together with the new
      //    content, so the page never sits in a "new dir / old
      //    strings" mixed state where the sidebar would animate
      //    across the viewport.
      router.refresh();
    },
    [router],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ar" ? "en" : "ar");
  }, [locale, setLocale]);

  const value = useMemo(
    () => ({ locale, setLocale, toggleLocale }),
    [locale, setLocale, toggleLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }

  return context;
}
