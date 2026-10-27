/**
 * Lossless JSON projection for decoded protobuf values.
 *
 * Rules, all visible in the output and documented in README:
 *  - 64-bit integers inside the JS safe range are numbers.
 *  - 64-bit integers outside it become `{"$number": "123..."}` so no digit is lost.
 *  - Non-finite doubles become `{"$number": "NaN" | "Infinity" | "-Infinity"}`.
 *  - bytes become `{"$bytes": "<base64>"}`; the byte length is kept alongside.
 *  - enums render as their name plus the raw number: `{"$enum": "NAME", "value": 1}`.
 *    Unknown numeric enum values render as `{"$enum": null, "value": 42}`.
 *  - maps with non-string keys become an array of {key, value} pairs.
 *  - present-but-default values are distinguishable from absent fields because
 *    absent fields are omitted entirely.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

export function longToJson(value: bigint): JsonValue {
  if (value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT) return Number(value);
  return { $number: value.toString() };
}

export function doubleToJson(value: number): JsonValue {
  if (Number.isFinite(value)) return value;
  return { $number: String(value) };
}

export function bytesToJson(bytes: Uint8Array): JsonValue {
  return { $bytes: base64FromBytes(bytes), byteLength: bytes.length };
}

export function enumToJson(name: string | undefined, value: number): JsonValue {
  return { $enum: name ?? null, value };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
