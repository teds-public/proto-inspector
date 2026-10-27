/** Byte helpers shared by capture, decoding and rendering. No DOM, no chrome APIs. */

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array, separator = ""): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    parts[i] = (HEX[b >> 4] ?? "0") + (HEX[b & 0x0f] ?? "0");
  }
  return parts.join(separator);
}

/** Formats bytes as a classic offset/hex/ascii hexdump. */
export function hexDump(bytes: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = [];
  const width = Math.min(Math.max(bytesPerLine, 1), 64);
  for (let offset = 0; offset < bytes.length; offset += width) {
    const slice = bytes.subarray(offset, offset + width);
    const hex = toHex(slice, " ").padEnd(width * 3 - 1, " ");
    let ascii = "";
    for (const b of slice) ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Strict Base64 decode. Throws on characters outside the standard alphabet. */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Invalid Base64 payload");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decodes UTF-8, returning null when the bytes are not valid UTF-8.
 * Callers must not confuse this with a lossy decode: binary frames need an
 * explicit non-text representation instead.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Printable ASCII heuristic used only to *suggest* that a payload is text. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let control = 0;
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) control++;
  }
  return control / bytes.length < 0.05;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
