#!/usr/bin/env node
/**
 * Single version for the app: sets (or checks) it in app/package.json (+ lock),
 * app/src-tauri/tauri.conf.json, app/src-tauri/Cargo.toml (+ lock) and the mod
 * (importcity_version.lua: logged by the mod, compared by the app; mod.json `revision`, an integer the
 * game shows as « rev. N » and mod.io needs growing: major × 10000 + minor × 100 + patch, 1.0.3 → 10003).
 * The mod zip also carries it in its file name (tools/pack-mod.mjs).
 *
 *   node tools/bump-version.mjs 0.2.0          set everywhere
 *   node tools/bump-version.mjs 0.2.0 --check  fail unless everything already says 0.2.0 (CI, tags)
 *   node tools/bump-version.mjs --print        print the current version
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => join(root, ...parts);

const files = {
  pkg: p("app", "package.json"),
  lock: p("app", "package-lock.json"),
  tauri: p("app", "src-tauri", "tauri.conf.json"),
  cargo: p("app", "src-tauri", "Cargo.toml"),
  cargoLock: p("app", "src-tauri", "Cargo.lock"),
  mod: p("importcity", "mod", "content", "gui", "importcity_version.lua"),
  modJson: p("importcity", "mod", "mod.json"),
};

const read = (f) => readFileSync(f, "utf8");
const cargoRe = /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const cargoLockRe = /(\[\[package\]\]\nname = "importcity"\nversion = ")([^"]+)(")/;
const modRe = /^(return ")([^"]+)(")/m;

/** mod.json `revision` for a version (1.0.3 → 10003), and back. */
const revisionOf = (v) => {
  const [major, minor, patch] = v.split(/[.-]/).map(Number);
  return major * 10000 + minor * 100 + patch;
};
const versionOfRevision = (r) =>
  Number.isInteger(r) ? `${Math.floor(r / 10000)}.${Math.floor(r / 100) % 100}.${r % 100}` : undefined;

function current() {
  const lock = JSON.parse(read(files.lock));
  return {
    "app/package.json": JSON.parse(read(files.pkg)).version,
    "app/package-lock.json": lock.packages?.[""]?.version ?? lock.version,
    "app/src-tauri/tauri.conf.json": JSON.parse(read(files.tauri)).version,
    "app/src-tauri/Cargo.toml": read(files.cargo).match(cargoRe)?.[2],
    "app/src-tauri/Cargo.lock": read(files.cargoLock).replace(/\r\n/g, "\n").match(cargoLockRe)?.[2],
    "importcity/mod/content/gui/importcity_version.lua": read(files.mod).match(modRe)?.[2],
    "importcity/mod/mod.json (revision)": versionOfRevision(JSON.parse(read(files.modJson)).revision),
  };
}

function setJson(file, fn) {
  const text = read(file);
  const json = JSON.parse(text);
  fn(json);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
}

const args = process.argv.slice(2);
if (args.includes("--print")) {
  console.log(current()["app/package.json"]);
  process.exit(0);
}
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node tools/bump-version.mjs <x.y.z> [--check] | --print");
  process.exit(2);
}

if (args.includes("--check")) {
  const want = (f) => (f.endsWith("(revision)") ? version.replace(/-.*$/, "") : version);
  const wrong = Object.entries(current()).filter(([f, v]) => v !== want(f));
  for (const [f, v] of wrong) console.error(`${f}: ${v ?? "?"} (expected ${version})`);
  if (wrong.length) process.exit(1);
  console.log(`version ${version}: OK`);
  process.exit(0);
}

setJson(files.pkg, (j) => (j.version = version));
setJson(files.lock, (j) => {
  j.version = version;
  if (j.packages?.[""]) j.packages[""].version = version;
});
setJson(files.tauri, (j) => (j.version = version));
writeFileSync(files.cargo, read(files.cargo).replace(cargoRe, `$1${version}$3`));
const lockText = read(files.cargoLock);
const crlf = lockText.includes("\r\n");
const newLock = lockText.replace(/\r\n/g, "\n").replace(cargoLockRe, `$1${version}$3`);
writeFileSync(files.cargoLock, crlf ? newLock.replace(/\n/g, "\r\n") : newLock);
writeFileSync(files.mod, read(files.mod).replace(modRe, `$1${version}$3`));
setJson(files.modJson, (j) => (j.revision = revisionOf(version)));
console.log(current());
