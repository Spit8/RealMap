/** Base64 for typed arrays sent between windows as JSON (Tauri events). */

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function floatsToB64(a: Float32Array): string {
  return bytesToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

export function b64ToFloats(b64: string): Float32Array {
  const bytes = b64ToBytes(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
