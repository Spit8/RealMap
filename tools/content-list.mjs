#!/usr/bin/env node
/**
 * importcity/mod/_content.json: the index of the mod's content/ files, required by mod.io uploads
 * from the in-game Mod Manager. When it exists the game reads its file cache from it instead of
 * scanning content/, so an unlisted file is invisible to importcity::/ paths.
 *
 *   node tools/content-list.mjs            # (re)write importcity/mod/_content.json
 *   node tools/content-list.mjs --check    # exit 1 if it is out of date
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Never shipped (logs left by a test run). */
const RUNTIME = (rel) => rel.endsWith(".log");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** _content.json text for a mod folder (same layout as the game's own mods: 4-space JSON). */
export function contentJson(modDir) {
  const content = join(modDir, "content");
  const files = walk(content)
    .map((full) => relative(content, full).split(sep).join("/"))
    .filter((rel) => !RUNTIME(rel))
    .sort();
  return JSON.stringify({ archives: null, files }, null, 4) + "\n";
}

/** Current _content.json text, line endings normalised (a Windows checkout has CRLF). */
const readIndex = (path) => (existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null);

/** Rewrite <modDir>/_content.json if needed. @return true when the file changed */
export function writeContentJson(modDir) {
  const path = join(modDir, "_content.json");
  const text = contentJson(modDir);
  if (readIndex(path) === text) return false;
  writeFileSync(path, text);
  return true;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const modDir = join(dirname(fileURLToPath(import.meta.url)), "..", "importcity", "mod");
  if (process.argv.includes("--check")) {
    const path = join(modDir, "_content.json");
    if (readIndex(path) !== contentJson(modDir)) {
      console.error("importcity/mod/_content.json is out of date: run node tools/content-list.mjs");
      process.exit(1);
    }
    console.log("importcity/mod/_content.json OK");
  } else {
    console.log(writeContentJson(modDir) ? "importcity/mod/_content.json written" : "importcity/mod/_content.json unchanged");
  }
}
