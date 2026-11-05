import { describe, expect, it } from "vitest";
import { fetchBytes, looksLikeTiff } from "../src/lib/platform/fetchbytes";

const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 2, 3, 4]);

/** A fake fetch answering from a list (an Error = network failure), counting calls. */
function fakeFetch(answers: (Error | { status: number; body?: Uint8Array; length?: number })[]) {
  let calls = 0;
  const impl = async () => {
    const a = answers[Math.min(calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    const body = a.body ?? new Uint8Array();
    const headers = new Headers({ "content-length": String(a.length ?? body.length) });
    return new Response(body.slice().buffer, { status: a.status, headers });
  };
  return { impl, calls: () => calls };
}

const noSleep = async () => {};

describe("fetchBytes", () => {
  it("tries again after a dropped connection", async () => {
    const f = fakeFetch([new TypeError("Failed to fetch"), { status: 200, body: TIFF }]);
    const notices: string[] = [];
    const got = await fetchBytes("https://x/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep, onRetry: (s, r) => notices.push(`${s} ${r}`) });
    expect(got.bytes).toEqual(TIFF);
    expect(f.calls()).toBe(2);
    expect(notices[0]).toBe("2 Failed to fetch");
  });

  it("tries again when the body is shorter than Content-Length (the cut-short tile)", async () => {
    const f = fakeFetch([{ status: 200, body: TIFF.slice(0, 10), length: TIFF.length }, { status: 200, body: TIFF }]);
    const got = await fetchBytes("https://x/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep });
    expect(got.bytes).toEqual(TIFF);
    expect(f.calls()).toBe(2);
  });

  it("tries again on 503 and on a failed check", async () => {
    const xml = new TextEncoder().encode("<Error>SlowDown</Error>");
    const f = fakeFetch([{ status: 503 }, { status: 200, body: xml }, { status: 200, body: TIFF }]);
    const got = await fetchBytes("https://x/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep, check: looksLikeTiff });
    expect(got.bytes).toEqual(TIFF);
    expect(f.calls()).toBe(3);
  });

  it("hands back a passed status at once (tile in the sea)", async () => {
    const f = fakeFetch([{ status: 404 }]);
    const got = await fetchBytes("https://x/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep, passStatuses: [403, 404] });
    expect(got).toEqual({ status: 404, bytes: null });
    expect(f.calls()).toBe(1);
  });

  it("does not try again a refused request", async () => {
    const f = fakeFetch([{ status: 401 }]);
    await expect(fetchBytes("https://x/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep })).rejects.toThrow("HTTP 401");
    expect(f.calls()).toBe(1);
  });

  it("gives up after four tries with the last reason", async () => {
    const f = fakeFetch([new TypeError("Failed to fetch")]);
    await expect(fetchBytes("https://host/dir/a.tif", { fetchImpl: f.impl, sleepImpl: noSleep })).rejects.toThrow("host/…/a.tif: Failed to fetch");
    expect(f.calls()).toBe(4);
  });
});
