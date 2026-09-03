"use client";

import { Languages } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import type { Locale } from "@/lib/locale";

/**
 * Language toggle — flips the UI between English and Arabic.
 *
 * The button always labels the *destination* language ("Switch to
 * العربية" when in English, "Switch to English" when in Arabic) so
 * screen-reader users hear what the click will do, matching the
 * ModeToggle pattern. Sizing and hit target match mode-toggle (40×40).
 *
 * `ko` is not part of the toggle cycle (the Korean catalogue stays
 * reachable via the `wacrm.locale` cookie / env var), so only `en`
 * and `ar` appear here.
 */

const LANGUAGE_LABELS: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
  ar: "العربية",
};

export function LocaleToggle() {
  const t = useTranslations("LocaleToggle");
  const { locale, setLocale } = useLocale();

  const nextLocale: Locale = locale === "ar" ? "en" : "ar";

  const label = t("switchTo", {
    language: LANGUAGE_LABELS[nextLocale],
  });

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-10 w-10 rounded-md text-muted-foreground"
      aria-label={label}
      title={label}
      onClick={() => setLocale(nextLocale)}
    >
      <Languages className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}
