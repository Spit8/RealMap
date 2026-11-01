import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/lib/i18n/en";
import { fr } from "../src/lib/i18n/fr";
import { de } from "../src/lib/i18n/de";
import { es } from "../src/lib/i18n/es";
import { it as itLang } from "../src/lib/i18n/it";
import { zh } from "../src/lib/i18n/zh";
import { CARGO_TIER } from "../src/lib/core/townneeds";
import { INDUSTRIES } from "../src/lib/core/industries";

const root = join(__dirname, "..", "..");
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const printf = (s: string) => [...s.matchAll(/%[sd]/g)].map((m) => m[0]);

/** Flat `key = "text",` entries of one language table of the mod's i18n file. */
function luaTable(src: string, lang: string): Record<string, string> {
  const m = new RegExp(`\\n\\t${lang} = \\{\\n([\\s\\S]*?)\\n\\t\\},`).exec(src);
  if (!m) throw new Error(`no ${lang} table`);
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const e = /^\s*(\w+)\s*=\s*"((?:[^"\\]|\\.)*)",?\s*$/.exec(line);
    if (e) out[e[1]] = e[2];
  }
  return out;
}

describe("translations", () => {
  it("app: same keys and placeholders in fr and en, a context for every section", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const k of Object.keys(fr) as (keyof typeof fr)[]) {
      expect(params(en[k]), k).toEqual(params(fr[k]));
      expect(en[k].trim(), k).not.toBe("");
    }
    const ctx = JSON.parse(readFileSync(join(root, "tools", "i18n", "context.json"), "utf8")) as { sections: Record<string, string> };
    for (const k of Object.keys(fr)) {
      const parts = k.split(".");
      const has = parts.some((_, n) => ctx.sections[parts.slice(0, parts.length - n).join(".")]);
      expect(has, `context section for ${k}`).toBe(true);
    }
  });

  it("app: every message built in the core and the worker has a text", () => {
    const dir = join(__dirname, "..", "src", "lib");
    const files = [
      ...readdirSync(join(dir, "core")).map((f) => join(dir, "core", f)),
      join(dir, "workers", "terrain.worker.ts"),
    ].filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bmsg\("([\w.]+)"|label: "(progress\.\w+)"|add\("\w+", [^,]+, [\d.]+, "(why\.\w+)"\)/g)) {
        const key = m[1] ?? m[2] ?? m[3];
        if (key.startsWith("@")) continue;
        expect(key in fr, `${file}: ${key}`).toBe(true);
      }
    }
  });

  it("app: every industry and town good has a name", () => {
    for (const tag of Object.keys(INDUSTRIES)) expect(`industry.${tag}` in fr, tag).toBe(true);
    for (const cargo of Object.keys(CARGO_TIER)) expect(`cargo.${cargo}` in fr, cargo).toBe(true);
  });

  it("mod: same keys and %s / %d in the same order in en and fr", () => {
    const lua = readFileSync(join(root, "importcity", "mod", "content", "gui", "importcity_i18n.lua"), "utf8");
    const modEn = luaTable(lua, "en");
    const modFr = luaTable(lua, "fr");
    expect(Object.keys(modFr).sort()).toEqual(Object.keys(modEn).sort());
    for (const k of Object.keys(modEn)) expect(printf(modFr[k]), k).toEqual(printf(modEn[k]));
    // Every key the mod uses exists.
    for (const file of ["importcity_auto.lua", "importcity_build.lua"]) {
      const src = readFileSync(join(root, "importcity", "mod", "content", "gui", file), "utf8");
      for (const m of src.matchAll(/\btr\("(\w+)"|i18n\.t\("(\w+)"/g)) expect(modEn[m[1] ?? m[2]], `${file}: ${m[1] ?? m[2]}`).toBeDefined();
    }
  });

  // The generated languages (lowCost_Translator, tools/i18n/import.mts): app files and mod tables.
  const dir = join(__dirname, "..", "src", "lib", "i18n");
  const DICTS: Record<string, Record<string, string>> = { de, it: itLang, es, zh };
  const generated = readdirSync(dir).filter((f) => /^[a-z]{2}\.ts$/.test(f) && !["fr.ts", "en.ts"].includes(f)).map((f) => f.slice(0, 2));

  it("generated languages: same keys and placeholders as French, nothing empty", () => {
    // Every generated file is imported above (a new language must be added there too).
    expect(generated.sort()).toEqual(Object.keys(DICTS).sort());
    for (const lang of generated) {
      const dict = DICTS[lang];
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(fr).sort());
      for (const k of Object.keys(fr) as (keyof typeof fr)[]) {
        expect(params(dict[k]), `${lang} ${k}`).toEqual(params(fr[k]));
        expect(dict[k].trim(), `${lang} ${k}`).not.toBe("");
      }
    }
  });

  it("generated languages are offered in the picker and have a mod table", () => {
    const index = readFileSync(join(dir, "index.svelte.ts"), "utf8");
    const lua = readFileSync(join(root, "importcity", "mod", "content", "gui", "importcity_i18n.lua"), "utf8");
    const modEn = luaTable(lua, "en");
    for (const lang of generated) {
      expect(index, lang).toMatch(new RegExp(`LOCALES = \\{[^}]*\\b${lang}\\b`));
      expect(index, lang).toMatch(new RegExp(`${lang}: "${lang}-[A-Z]{2}"`));
      const t = luaTable(lua, lang);
      expect(Object.keys(t).sort(), lang).toEqual(Object.keys(modEn).sort());
      for (const k of Object.keys(modEn)) expect(printf(t[k]), `${lang} ${k}`).toEqual(printf(modEn[k]));
    }
  });
});

