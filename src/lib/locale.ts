/**
 * Locale primitives shared between the server (src/i18n/request.ts),
 * the root layout boot script, and the client LocaleProvider.
 *
 * Keep this file dependency-free and framework-agnostic — the boot
 * script in layout.tsx inlines the same key/default values, and the
 * server request config imports these helpers directly. A single
 * source of truth avoids the two paths drifting apart.
 */

/** localStorage + cookie key the picked locale is persisted under. */
export const LOCALE_STORAGE_KEY = "wacrm.locale";

/**
 * Every locale the app can render. `ko` stays in the list so the
 * existing Korean catalogue keeps loading, even though the header
 * toggle only flips between English and Arabic.
 */
export const LOCALES = ["en", "ko", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

/** The two locales the header toggle cycles between. */
export const TOGGLE_LOCALES = ["en", "ar"] as const;

/** Fallback when no cookie / env / stored value resolves. */
export const DEFAULT_LOCALE: Locale = "en";

/** Locales rendered right-to-left. */
export const RTL_LOCALES = ["ar"] as const;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.includes(value as Locale);
}

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale as (typeof RTL_LOCALES)[number]);
}

/** Text direction for a locale — used on <html dir>. */
export function dirForLocale(locale: Locale): "rtl" | "ltr" {
  return isRtl(locale) ? "rtl" : "ltr";
}
