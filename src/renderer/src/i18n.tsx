import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { INTL_LOCALE, translator, type Locale, type Translate } from "../../shared/i18n";

type I18n = { locale: Locale; intl: string; t: Translate };

const Ctx = createContext<I18n>({ locale: "en", intl: INTL_LOCALE.en, t: translator("en") });

/** Loads the UI language from settings and follows changes from any window. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(() => {
    void window.api.getSettings().then((s) => setLocale(s.locale));
    return window.api.onLocale(setLocale);
  }, []);
  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);
  // Render nothing until the language is known, so the first frame is not in the wrong one.
  if (!locale) return null;
  return <Ctx.Provider value={{ locale, intl: INTL_LOCALE[locale], t: translator(locale) }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
