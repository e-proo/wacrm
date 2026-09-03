import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Inter, Noto_Sans_Arabic } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/hooks/use-theme";
import { LocaleProvider } from "@/hooks/use-locale";
import { ThemedToaster } from "@/components/themed-toaster";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  LOCALES,
  RTL_LOCALES,
  dirForLocale,
  isLocale,
  type Locale,
} from "@/lib/locale";

// Latin UI font — drives --font-sans-latin. Applied for LTR locales.
const inter = Inter({
  variable: "--font-sans-latin",
  subsets: ["latin"],
});

// Arabic UI font — drives --font-sans-arabic. globals.css swaps
// --font-sans over to this variable when <html dir="rtl">.
const notoSansArabic = Noto_Sans_Arabic({
  variable: "--font-sans-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "wacrm",
    template: "%s — wacrm",
  },
  description: "Self-hostable CRM template for WhatsApp.",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
  }
})();
`;

// Inline boot script for the language — sibling to the theme boot
// script above. Runs before React hydrates so `<html lang>` and
// `<html dir>` match the user's saved locale before first paint,
// preventing an LTR→RTL flash (and a wrong-font flash) on load.
//
// Reads the same `wacrm.locale` localStorage key the client
// LocaleProvider writes. Kept dependency-free (a plain string the
// browser runs as one <script>); valid locales + the RTL set come
// from the shared LOCALES / RTL_LOCALES constants so adding a locale
// can't silently break the boot path.
const LOCALE_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var KEY = ${JSON.stringify(LOCALE_STORAGE_KEY)};
    var LOCALES = ${JSON.stringify(LOCALES)};
    var RTL = ${JSON.stringify(RTL_LOCALES)};
    var DEFAULT = ${JSON.stringify(DEFAULT_LOCALE)};
    var saved = localStorage.getItem(KEY);
    var locale = LOCALES.indexOf(saved) !== -1 ? saved : d.lang || DEFAULT;
    if (LOCALES.indexOf(locale) === -1) locale = DEFAULT;
    d.lang = locale;
    d.dir = RTL.indexOf(locale) !== -1 ? "rtl" : "ltr";
  } catch (_e) {
    d.dir = d.dir || "ltr";
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const rawLocale = await getLocale();
  const messages = await getMessages();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dir = dirForLocale(locale);

  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className={`${inter.variable} ${notoSansArabic.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
        <Script
          id="locale-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <LocaleProvider initialLocale={locale}>
            <ThemeProvider>
              {children}
              <ThemedToaster />
            </ThemeProvider>
          </LocaleProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
