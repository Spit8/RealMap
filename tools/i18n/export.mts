// Builds tools/i18n/units.json (input of lowCost_Translator's units mode) from the app's en.ts /
// fr.ts and the mod's en / fr tables (i18n.lua). Run from app/: npx tsx ../tools/i18n/export.mts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../app/src/lib/i18n/en";
import { fr } from "../../app/src/lib/i18n/fr";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ctx = JSON.parse(readFileSync(join(here, "context.json"), "utf8")) as {
  sections: Record<string, string>;
  kinds: Record<string, string>;
};

type Unit = { id: string; text: string; ref: string; context: string; kind: string };

/** Section text of the longest dotted prefix of the key. */
function section(key: string): string {
  const parts = key.split(".");
  for (let n = parts.length; n > 0; n--) {
    const s = ctx.sections[parts.slice(0, n).join(".")];
    if (s) return s;
  }
  throw new Error(`no context section for ${key}`);
}

function kind(id: string, key: string, text: string): string {
  const fixed = ctx.kinds[id] ?? ctx.kinds[key];
  if (fixed) return fixed;
  const last = key.split(/[.:]/).pop()!;
  if (last.endsWith("Title")) return "tooltip";
  if (last === "title") return "title";
  if (/hint/i.test(last)) return "sentence";
  if (/\.(err|block)\./.test(key) || /^(err_|status_)/.test(last)) return "status";
  if (text.length > 70 || /[.!?]\s/.test(text)) return "sentence";
  return "label";
}

/** Flat `key = "text",` entries of one language table of i18n.lua. */
function luaTable(src: string, lang: string): Record<string, string> {
  const m = new RegExp(`\\n\\t${lang} = \\{\\n([\\s\\S]*?)\\n\\t\\},`).exec(src);
  if (!m) throw new Error(`i18n.lua: no ${lang} table`);
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const e = /^\s*(\w+)\s*=\s*"((?:[^"\\]|\\.)*)",?\s*$/.exec(line);
    if (e) out[e[1]!] = e[2]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

const units: Unit[] = [];
for (const key of Object.keys(fr) as (keyof typeof fr)[]) {
  if (key === "lang.name") continue;
  const text = en[key];
  units.push({ id: `app:${key}`, text, ref: fr[key], context: section(key), kind: kind(`app:${key}`, key, text) });
}
const lua = readFileSync(join(root, "importcity", "mod", "content", "gui", "importcity_i18n.lua"), "utf8");
const modEn = luaTable(lua, "en"), modFr = luaTable(lua, "fr");
for (const [key, text] of Object.entries(modEn)) {
  units.push({ id: `mod:${key}`, text, ref: modFr[key] ?? "", context: ctx.sections.mod!, kind: kind(`mod:${key}`, key, text) });
}
writeFileSync(join(here, "units.json"), JSON.stringify(units, null, 2) + "\n");
const byKind = units.reduce<Record<string, number>>((a, u) => ((a[u.kind] = (a[u.kind] ?? 0) + 1), a), {});
console.log(`units.json: ${units.length} units (app ${units.length - Object.keys(modEn).length}, mod ${Object.keys(modEn).length})`, byKind);
