/**
 * Downloads that survive a flaky connection: the Tauri http plugin can drop the connection
 * (`TypeError: Failed to fetch` in `readChunk`) or, worse, hand back a body short of a chunk
 * without any error (a Copernicus tile cached 16 KiB short, then unreadable for good). Each
 * download is checked (length against `Content-Length`, plus the caller's check) and tried again.
 */

/** Pauses (s) before the 2nd, 3rd and 4th tries. */
export const RETRY_WAIT_S = [2, 5, 15];

export type RetryNotice = (seconds: number, reason: string) => void;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchBytesOptions {
  headers?: Record<string, string>;
  /** Per try (ms). */
  timeoutMs?: number;
  /** False: the bytes are not what was asked (error page, cut short…): try again. */
  check?: (bytes: Uint8Array) => boolean;
  /** Called once per second while waiting before a new try. */
  onRetry?: RetryNotice;
  /** Statuses returned as they are, without trying again (403 / 404: tile in the sea). */
  passStatuses?: number[];
  waits?: number[];
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type FetchBytesResult = { status: number; bytes: Uint8Array<ArrayBuffer> | null };

/** One try: bytes, a status to hand back as is, or a reason to try again (thrown). */
async function once(url: string, o: FetchBytesOptions, fetchImpl: FetchLike): Promise<FetchBytesResult> {
  const res = await fetchImpl(url, {
    headers: o.headers,
    signal: o.timeoutMs ? AbortSignal.timeout(o.timeoutMs) : undefined,
  });
  if (o.passStatuses?.includes(res.status)) return { status: res.status, bytes: null };
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    // Other 4xx (refused, bad request): another try would get the same answer.
    if (res.status !== 429 && res.status < 500) (err as Error & { final?: boolean }).final = true;
    throw err;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const len = Number(res.headers.get("content-length"));
  const encoded = (res.headers.get("content-encoding") ?? "identity") !== "identity";
  if (!encoded && Number.isFinite(len) && len > 0 && bytes.length !== len) throw new Error(`incomplete answer (${bytes.length}/${len} B)`);
  if (o.check && !o.check(bytes)) throw new Error(`unexpected content (${bytes.length} B)`);
  return { status: res.status, bytes };
}

/**
 * Bytes of `url`, tried up to `waits.length + 1` times on a network error, a timeout, HTTP 429 /
 * 5xx, an answer shorter than its `Content-Length` or a failed `check`. A status of `passStatuses`
 * comes back with `bytes: null`. Throws the last reason when every try failed.
 */
export async function fetchBytes(url: string, o: FetchBytesOptions = {}): Promise<FetchBytesResult> {
  const fetchImpl = o.fetchImpl ?? (await import("@tauri-apps/plugin-http")).fetch;
  const sleep = o.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = o.waits ?? RETRY_WAIT_S;
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(url, o, fetchImpl);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if ((e as { final?: boolean }).final || attempt >= waits.length) throw new Error(`${shortUrl(url)}: ${reason}`);
      for (let s = waits[attempt]; s > 0; s--) {
        o.onRetry?.(s, reason);
        await sleep(1000);
      }
    }
  }
}

/** The file name of a URL, for messages. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + "/…/" + (u.pathname.split("/").pop() || "");
  } catch {
    return url;
  }
}

/** A GeoTIFF starts with "II*" or "MM*" (an S3 / WCS error comes back as XML). */
export function looksLikeTiff(b: Uint8Array): boolean {
  return b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a));
}
