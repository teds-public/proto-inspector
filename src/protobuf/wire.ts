/**
 * Schema-free Protobuf wire-format inspector.
 *
 * Deliberately independent of protobufjs: this parser must reject malformed
 * input safely and never allocate beyond the configured limits.
 */

export const WIRE_TYPE = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  START_GROUP: 3,
  END_GROUP: 4,
  FIXED32: 5,
} as const;

export type WireType = (typeof WIRE_TYPE)[keyof typeof WIRE_TYPE];

const WIRE_TYPE_NAMES: Record<number, string> = {
  0: "varint",
  1: "fixed64",
  2: "length-delimited",
  3: "start-group",
  4: "end-group",
  5: "fixed32",
};

export function wireTypeName(wireType: number): string {
  return WIRE_TYPE_NAMES[wireType] ?? `unknown(${wireType})`;
}

export interface WireLimits {
  /** Maximum bytes accepted for a single message. */
  readonly maxMessageBytes: number;
  /** Maximum nesting depth while following nested message interpretations. */
  readonly maxDepth: number;
  /** Maximum number of fields decoded from one message level. */
  readonly maxFields: number;
  /** Maximum length of a length-delimited payload inspected as a nested message. */
  readonly maxNestedBytes: number;
}

export const DEFAULT_WIRE_LIMITS: WireLimits = {
  maxMessageBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxFields: 10_000,
  maxNestedBytes: 64 * 1024,
};

/** A varint wider than this cannot be a legal 64-bit protobuf varint. */
const MAX_VARINT_BYTES = 10;
const MAX_FIELD_NUMBER = 536_870_911;

export type VarintValue =
  | { readonly kind: "safe"; readonly value: number }
  | { readonly kind: "bigint"; readonly value: bigint };

export interface WireFieldBase {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly wireTypeName: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface WireVarintField extends WireFieldBase {
  readonly kind: "varint";
  readonly value: VarintValue;
  /** Signed two's-complement interpretation of the raw varint truncated to 64 bits. */
  readonly signed64: bigint;
  readonly zigzag64: bigint;
}

export interface WireFixed64Field extends WireFieldBase {
  readonly kind: "fixed64";
  readonly raw: bigint;
  readonly asDouble: number;
  readonly asInt64: bigint;
  readonly asUint64: bigint;
}

export interface WireFixed32Field extends WireFieldBase {
  readonly kind: "fixed32";
  readonly raw: number;
  readonly asFloat: number;
  readonly asInt32: number;
  readonly asUint32: number;
}

export interface WireBytesField extends WireFieldBase {
  readonly kind: "length-delimited";
  readonly length: number;
  /** Present when the payload is valid UTF-8. */
  readonly utf8: string | null;
  /** Non-null when the payload also parses as a nested message. */
  readonly nested: readonly WireField[] | null;
  readonly nestedTruncated: boolean;
  readonly nestedError: string | null;
}

export interface WireGroupField extends WireFieldBase {
  readonly kind: "group";
  readonly fields: readonly WireField[];
}

export type WireField = WireVarintField | WireFixed64Field | WireFixed32Field | WireBytesField | WireGroupField;

export interface WireParseResult {
  readonly fields: readonly WireField[];
  /** True when a configured limit stopped the walk before the end of input. */
  readonly truncated: boolean;
  readonly truncatedReason: string | null;
  readonly consumedBytes: number;
}

export class WireFormatError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "WireFormatError";
    this.offset = offset;
  }
}

interface Frame {
  readonly bytes: Uint8Array;
  pos: number;
  readonly end: number;
}

function readVarint(f: Frame): { value: bigint; offset: number; length: number } {
  const offset = f.pos;
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (f.pos >= f.end) throw new WireFormatError("Truncated varint", offset);
    const byte = f.bytes[f.pos++] ?? 0;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset, length: f.pos - offset };
    shift += 7n;
  }
  throw new WireFormatError("Varint longer than 10 bytes", offset);
}

function readFixedBigUint(f: Frame, byteCount: 4 | 8): { raw: bigint; view: DataView } {
  if (f.end - f.pos < byteCount) throw new WireFormatError(`Truncated ${byteCount}-byte field`, f.pos);
  const view = new DataView(f.bytes.buffer, f.bytes.byteOffset + f.pos, byteCount);
  const raw = byteCount === 8 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
  f.pos += byteCount;
  return { raw, view };
}

function toVarintValue(value: bigint): VarintValue {
  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? { kind: "safe", value: Number(value) }
    : { kind: "bigint", value };
}

/** Reinterprets an unsigned 64-bit varint as its signed two's-complement value. */
function asInt64(value: bigint): bigint {
  const masked = value & 0xffffffffffffffffn;
  return masked >= 0x8000000000000000n ? masked - 0x10000000000000000n : masked;
}

function zigzag64(value: bigint): bigint {
  const unsigned = value & 0xffffffffffffffffn;
  return (unsigned >> 1n) ^ -(unsigned & 1n);
}

function strictUtf8(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses a protobuf message body.
 *
 * Throws WireFormatError on malformed input. Returns a truncated result when a
 * configured limit is reached so the UI can still show what was decoded.
 */
export function parseWireFormat(
  input: Uint8Array,
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): WireParseResult {
  if (input.length > limits.maxMessageBytes) {
    throw new WireFormatError(
      `Message of ${input.length} bytes exceeds limit of ${limits.maxMessageBytes}`,
      0,
    );
  }
  const frame: Frame = { bytes: input, pos: 0, end: input.length };
  const result = parseLevel(frame, limits, 0, null);
  return { ...result, consumedBytes: frame.pos };
}

/**
 * Parses fields until the end of the frame, or — inside a group — until the
 * matching end-group tag.
 */
function parseLevel(
  f: Frame,
  limits: WireLimits,
  depth: number,
  groupFieldNumber: number | null,
): { fields: WireField[]; truncated: boolean; truncatedReason: string | null } {
  if (depth > limits.maxDepth) {
    throw new WireFormatError(`Nesting deeper than ${limits.maxDepth} levels`, f.pos);
  }
  const fields: WireField[] = [];
  let truncated = false;
  let truncatedReason: string | null = null;

  while (f.pos < f.end) {
    if (fields.length >= limits.maxFields) {
      truncated = true;
      truncatedReason = `Field limit of ${limits.maxFields} reached`;
      break;
    }
    const fieldOffset = f.pos;
    const tag = readVarint(f);
    if (tag.value > 0xffffffffn) {
      throw new WireFormatError("Field tag exceeds 32 bits", tag.offset);
    }
    const tagNumber = Number(tag.value);
    const fieldNumber = tagNumber >>> 3;
    const wireType = tagNumber & 0x07;
    if (fieldNumber === 0) throw new WireFormatError("Invalid field number 0", tag.offset);
    if (fieldNumber > MAX_FIELD_NUMBER) {
      throw new WireFormatError(`Field number ${fieldNumber} exceeds 2^29-1`, tag.offset);
    }

    const base = {
      fieldNumber,
      wireType,
      wireTypeName: wireTypeName(wireType),
      byteOffset: fieldOffset,
    };

    if (wireType === WIRE_TYPE.END_GROUP) {
      if (groupFieldNumber === null) {
        throw new WireFormatError(`Unexpected end-group for field ${fieldNumber}`, tag.offset);
      }
      if (fieldNumber !== groupFieldNumber) {
        throw new WireFormatError(
          `Mismatched end-group ${fieldNumber}, expected ${groupFieldNumber}`,
          tag.offset,
        );
      }
      return { fields, truncated, truncatedReason };
    }

    switch (wireType) {
      case WIRE_TYPE.VARINT: {
        const v = readVarint(f);
        fields.push({
          ...base,
          kind: "varint",
          byteLength: f.pos - fieldOffset,
          value: toVarintValue(v.value),
          signed64: asInt64(v.value),
          zigzag64: zigzag64(v.value),
        });
        break;
      }
      case WIRE_TYPE.FIXED64: {
        const { raw, view } = readFixedBigUint(f, 8);
        fields.push({
          ...base,
          kind: "fixed64",
          byteLength: f.pos - fieldOffset,
          raw,
          asDouble: view.getFloat64(0, true),
          asInt64: view.getBigInt64(0, true),
          asUint64: raw,
        });
        break;
      }
      case WIRE_TYPE.FIXED32: {
        const { raw, view } = readFixedBigUint(f, 4);
        const value = Number(raw);
        fields.push({
          ...base,
          kind: "fixed32",
          byteLength: f.pos - fieldOffset,
          raw: value,
          asFloat: view.getFloat32(0, true),
          asInt32: view.getInt32(0, true),
          asUint32: value,
        });
        break;
      }
      case WIRE_TYPE.LENGTH_DELIMITED: {
        const lengthVarint = readVarint(f);
        const remaining = f.end - f.pos;
        if (lengthVarint.value > BigInt(remaining)) {
          throw new WireFormatError(
            `Length ${lengthVarint.value} exceeds remaining ${remaining} bytes`,
            lengthVarint.offset,
          );
        }
        const length = Number(lengthVarint.value);
        const payloadStart = f.pos;
        const payload = f.bytes.subarray(payloadStart, payloadStart + length);
        f.pos = payloadStart + length;

        let nested: readonly WireField[] | null = null;
        let nestedTruncated = false;
        let nestedError: string | null = null;
        if (length > 0 && length <= limits.maxNestedBytes) {
          const child: Frame = { bytes: f.bytes, pos: payloadStart, end: payloadStart + length };
          try {
            const parsed = parseLevel(child, limits, depth + 1, null);
            if (parsed.fields.length > 0 && child.pos === child.end) {
              nested = parsed.fields;
              nestedTruncated = parsed.truncated;
            }
          } catch (error) {
            nestedError = error instanceof Error ? error.message : String(error);
          }
        }

        fields.push({
          ...base,
          kind: "length-delimited",
          byteLength: f.pos - fieldOffset,
          length,
          utf8: strictUtf8(payload),
          nested,
          nestedTruncated,
          nestedError,
        });
        break;
      }
      case WIRE_TYPE.START_GROUP: {
        const inner = parseLevel(f, limits, depth + 1, fieldNumber);
        fields.push({
          ...base,
          kind: "group",
          byteLength: f.pos - fieldOffset,
          fields: inner.fields,
        });
        break;
      }
      default: {
        throw new WireFormatError(`Unsupported wire type ${wireType}`, tag.offset);
      }
    }
  }

  if (groupFieldNumber !== null) {
    throw new WireFormatError(`Unterminated group for field ${groupFieldNumber}`, f.pos);
  }
  return { fields, truncated, truncatedReason };
}

/** Cheap plausibility check used to badge frames; never treated as proof. */
export function looksLikeProtobuf(bytes: Uint8Array, limits: WireLimits = DEFAULT_WIRE_LIMITS): boolean {
  if (bytes.length === 0) return false;
  const frame: Frame = { bytes, pos: 0, end: bytes.length };
  try {
    const result = parseLevel(frame, { ...limits, maxDepth: 2, maxNestedBytes: 0 }, 0, null);
    return result.fields.length > 0 && !result.truncated && frame.pos === frame.end;
  } catch {
    return false;
  }
}

/** Compact one-line summary of the top-level fields, for the message table. */
export function summarizeWireFields(
  bytes: Uint8Array,
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): { fieldNumber: number; wireType: number; wireTypeName: string }[] | undefined {
  if (bytes.length === 0) return undefined;
  const frame: Frame = { bytes, pos: 0, end: bytes.length };
  try {
    const result = parseLevel(frame, { ...limits, maxNestedBytes: 0 }, 0, null);
    if (frame.pos !== frame.end) return undefined;
    return result.fields.map((field) => ({
      fieldNumber: field.fieldNumber,
      wireType: field.wireType,
      wireTypeName: field.wireTypeName,
    }));
  } catch {
    return undefined;
  }
}
