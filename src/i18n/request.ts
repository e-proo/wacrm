import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, type Locale, isLocale } from "@/lib/locale";

/**
 * Loads the message catalogue for a locale. Each locale is imported
 * explicitly (rather than a dynamic `messages/${locale}.json` template)
 * so the bundler can statically see every catalogue and the switch is
 * exhaustive — a new locale won't silently fall back to English.
 */
async function loadMessages(locale: Locale) {
  switch (locale) {
    case "ar":
      return (await import("../../messages/ar.json")).default;
    case "ko":
      return (await import("../../messages/ko.json")).default;
    case "en":
    default:
      return (await import("../../messages/en.json")).default;
  }
}

/**
 * Resolves the active locale for the request, in priority order:
 *   1. the `wacrm.locale` cookie (written client-side by LocaleProvider
 *      when the user flips the header toggle),
 *   2. the `NEXT_PUBLIC_APP_LOCALE` build-time default,
 *   3. `en`.
 *
 * The cookie is what makes the in-app toggle work: next-intl reads
 * messages on the server, so a language switch writes the cookie and
 * reloads, and this picks the new catalogue up on the next render.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();

  const cookieLocale = cookieStore.get(LOCALE_STORAGE_KEY)?.value;
  const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;

  const locale: Locale = isLocale(cookieLocale)
    ? cookieLocale
    : isLocale(envLocale)
      ? envLocale
      : DEFAULT_LOCALE;

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
