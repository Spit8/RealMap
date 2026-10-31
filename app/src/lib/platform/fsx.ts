/**
 * Thin file-system layer over the Tauri fs plugin (paths are absolute OS paths; scope in
 * src-tauri/capabilities/default.json). Everything else in the app goes through here.
 */
import {
  copyFile, exists, mkdir, readDir, readFile, readTextFile, remove, rename, stat, writeFile, writeTextFile,
} from "@tauri-apps/plugin-fs";

/** Join with the separator already used by `base` (Windows `\`, else `/`). */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  let out = base.replace(/[\\/]+$/, "");
  for (const p of parts) out += sep + p.replace(/^[\\/]+|[\\/]+$/g, "").replace(/[\\/]/g, sep);
  return out;
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  await writeTextFile(path, text);
}

export async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  // The plugin always returns a fresh (non-shared) buffer.
  return (await readFile(path)) as Uint8Array<ArrayBuffer>;
}

export async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  await writeFile(path, data);
}

export async function ensureDir(path: string): Promise<void> {
  if (!(await fileExists(path))) await mkdir(path, { recursive: true });
}

/** Last modification time (ms since epoch) and size, or null if missing. */
export async function fileStat(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtime ? new Date(s.mtime).getTime() : 0, size: s.size };
  } catch {
    return null;
  }
}

export interface DirFile {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Files (not dirs) of a directory with their stat; names filtered by `filter`. */
export async function listFiles(dir: string, filter?: RegExp): Promise<DirFile[]> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
  const out: DirFile[] = [];
  for (const e of entries) {
    if (!e.isFile || (filter && !filter.test(e.name))) continue;
    const path = joinPath(dir, e.name);
    const s = await fileStat(path);
    if (s) out.push({ name: e.name, path, ...s });
  }
  return out;
}

export async function copy(src: string, dest: string): Promise<void> {
  await copyFile(src, dest);
}

export async function removeFile(path: string): Promise<void> {
  try {
    await remove(path);
  } catch {
    /* already gone */
  }
}

/** Delete a directory and its content; true when it is gone (missing counts as gone). */
export async function removeDir(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (await fileExists(path)) await remove(path, { recursive: true });
    } catch {
      /* file briefly locked (antivirus, indexer…): retry */
    }
    if (!(await fileExists(path))) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function renamePath(from: string, to: string): Promise<void> {
  await rename(from, to);
}
