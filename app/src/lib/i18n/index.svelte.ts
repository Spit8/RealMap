/**
 * UI translations (DECISION-017, after HQminiMap): t(key, params) reads the current locale (a rune),
 * so templates update when the language changes. fr (source) and en are written by hand; other
 * languages are generated from en with their context (`tools/i18n/README.md`), then registered in
 * LOCALES and TAGS. Messages computed in the core or the worker are `Msg` (key + params, `tm`); only
 * the technical journal (`diag`) stays in French.
 */
import { de } from "./de";
import type { Msg } from "../core/msg";
import { en } from "./en";
import { es } from "./es";
import { fr, type MessageKey } from "./fr";
import { it } from "./it";
import { zh } from "./zh";

export type { MessageKey };

export const LOCALES = { fr, en, de, it, es, zh } as const;
export type Locale = keyof typeof LOCALES;
/** BCP 47 tag of each language (number formatting, the page's lang). */
const TAGS: Record<Locale, string> = { fr: "fr-FR", en: "en-GB", de: "de-DE", it: "it-IT", es: "es-ES", zh: "zh-CN" };
const LS_KEY = "importcity.locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && saved in LOCALES) return saved as Locale;
  } catch {
    /* storage unavailable */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "fr").slice(0, 2).toLowerCase();
  return (nav in LOCALES ? nav : "en") as Locale;
}

function setDocumentLang(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = TAGS[locale];
}

class I18n {
  locale = $state<Locale>(detect());

  constructor() {
    setDocumentLang(this.locale);
  }

  set(locale: Locale): void {
    this.locale = locale;
    setDocumentLang(locale);
    try {
      localStorage.setItem(LS_KEY, locale);
    } catch {
      /* storage unavailable */
    }
  }

  /** BCP 47 tag for number formatting. */
  get tag(): string {
    return TAGS[this.locale];
  }
}

export const i18n = new I18n();

export type Params = Record<string, string | number>;

/** Translated string; `{name}` placeholders replaced from params. Falls back to French, then the key. */
export function t(key: MessageKey, params?: Params): string {
  const dict = LOCALES[i18n.locale] as Record<MessageKey, string>;
  let s: string = dict[key] ?? fr[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** A key built at run time (industry tags, cargo names…): the key itself when it is unknown. */
export function tk(key: string, params?: Params): string {
  return key in fr ? t(key as MessageKey, params) : key;
}

/** A message from the core or the worker (`core/msg.ts`), or a plain text (real names, OSM tags). */
export function tm(m: Msg | string | null | undefined): string {
  if (m == null) return "";
  if (typeof m === "string") return m;
  // A list of industry types (`{ key: "@industries", params: { tags: "saw_mill,brewery" } }`).
  if (m.key === "@industries") return String(m.params?.tags ?? "").split(",").filter(Boolean).map((tag) => tk(`industry.${tag}`)).join(", ");
  const params: Params = {};
  for (const [k, v] of Object.entries(m.params ?? {})) params[k] = typeof v === "object" ? tm(v) : v;
  return tk(m.key, params);
}

/** Locale-aware number. */
export function fmtNum(v: number, digits = 0): string {
  return v.toLocaleString(i18n.tag, { maximumFractionDigits: digits });
}
