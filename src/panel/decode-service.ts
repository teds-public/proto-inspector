/**
 * Panel-side decoding pipeline: schema (or wire fallback).
 *
 * Kept free of DOM access so it can be unit-tested and reused by the export
 * path. Everything here is synchronous and bounded by the supplied limits.
 */

import protobuf from "protobufjs";
import {
  DEFAULT_DECODE_LIMITS,
  decodeWithSchema,
  listDecodableTypes,
  type DecodeLimits,
} from "../protobuf/schema";
import {
  DEFAULT_WIRE_LIMITS,
  WireFormatError,
  parseWireFormat,
  type WireField,
  type WireLimits,
  type WireParseResult,
} from "../protobuf/wire";
import type { JsonValue } from "../protobuf/json-value";
import {
  opcodeTypeFor,
  splitFrame,
  type FramePrefixMode,
  type OpcodeRegistry,
} from "../protobuf/opcode";
import type { DecodeStatus } from "../shared/model";

export interface DecodeRequest {
  readonly bytes: Uint8Array;
  readonly isTextFrame: boolean;
  readonly root: protobuf.Root | null;
  /** Message type chosen by the user for this frame. */
  readonly messageType: string | null;
  readonly wireLimits?: Partial<WireLimits>;
  readonly decodeLimits?: Partial<DecodeLimits>;

  /**
   * Frame direction, used to choose between the request and response type
   * declared for an opcode. Defaults to `send`.
   */
  readonly direction?: "send" | "receive";
  /** How a frame's opcode prefix is detected; defaults to `none`. */
  readonly prefixMode?: FramePrefixMode;
  /** Opcode → request/response types read from the loaded schema. */
  readonly opcodes?: OpcodeRegistry;

  /**
   * Type selected by a user-configured auto-decode rule. Sits between an
   * explicit pick and a shape-remembered one: the rule is configuration the
   * user wrote, so it beats reuse, but a pick for this exact frame still wins.
   */
  readonly ruledType?: string | null;
  /**
   * Type the user already chose for messages with the same wire shape. Applied
   * last, so anything more specific is never overridden.
   */
  readonly rememberedType?: string | null;
}

/** Where `messageType` came from, so the UI never presents a guess as certainty. */
export type TypeSource = "manual" | "rule" | "remembered" | "opcode" | null;

export interface DecodeOutcome {
  readonly status: DecodeStatus;
  readonly json: JsonValue | null;
  readonly error: string | null;
  readonly messageType: string | null;
  readonly typeSource: TypeSource;
  readonly payloadBytes: number;
  readonly wire: WireParseResult | WireFormatError | null;
  /** Opcode read from the frame prefix, when one was detected. */
  readonly opcode: number | null;
}

export function defaultWireLimits(overrides: Partial<WireLimits> = {}): WireLimits {
  return { ...DEFAULT_WIRE_LIMITS, ...overrides };
}

export function defaultDecodeLimits(overrides: Partial<DecodeLimits> = {}): DecodeLimits {
  return { ...DEFAULT_DECODE_LIMITS, ...overrides };
}

function wireOutcome(bytes: Uint8Array, wireLimits: WireLimits): WireParseResult | WireFormatError {
  try {
    return parseWireFormat(bytes, wireLimits);
  } catch (error) {
    if (error instanceof WireFormatError) return error;
    return new WireFormatError(error instanceof Error ? error.message : String(error), 0);
  }
}

export function decodeFrame(request: DecodeRequest): DecodeOutcome {
  const wireLimits = defaultWireLimits(request.wireLimits);
  const decodeLimits = defaultDecodeLimits(request.decodeLimits);
  const base = {
    messageType: null as string | null,
    typeSource: null as TypeSource,
    payloadBytes: request.bytes.byteLength,
    opcode: null as number | null,
  };

  if (request.bytes.byteLength === 0) {
    return { ...base, status: "payload-empty", json: null, error: null, wire: null };
  }
  if (request.isTextFrame) {
    return { ...base, status: "skipped-text", json: null, error: null, wire: null };
  }

  const split = splitFrame(
    request.bytes,
    request.prefixMode ?? "none",
    request.opcodes ?? new Map(),
  );
  const payload = split.payload;
  // An opcode-only frame (a ping, or a request with no body) has nothing to
  // decode, which is different from a frame that was never attempted.
  if (payload.byteLength === 0) {
    return {
      ...base,
      status: "payload-empty",
      json: null,
      error: null,
      wire: null,
      opcode: split.opcode,
    };
  }
  const wire = wireOutcome(payload, wireLimits);

  // The user's choice for this frame wins. A rule they wrote beats the type the
  // schema declares for the frame's opcode, which in turn beats a type reused
  // from another frame with the same shape. Nothing is guessed: an unnamed
  // frame stays at wire-format level.
  let messageType: string | null = request.messageType;
  let typeSource: TypeSource = messageType ? "manual" : null;
  if (!messageType && request.ruledType) {
    messageType = request.ruledType;
    typeSource = "rule";
  }
  if (!messageType && split.opcode !== null && request.opcodes) {
    const fromOpcode = opcodeTypeFor(request.opcodes, split.opcode, request.direction ?? "send");
    if (fromOpcode) {
      messageType = fromOpcode;
      typeSource = "opcode";
    }
  }
  if (!messageType && request.rememberedType) {
    messageType = request.rememberedType;
    typeSource = "remembered";
  }

  if (request.root && messageType) {
    try {
      const decoded = decodeWithSchema(request.root, messageType, payload, decodeLimits);
      return {
        status: "decoded",
        json: decoded.json as JsonValue,
        error: null,
        messageType: decoded.messageType,
        typeSource,
        payloadBytes: payload.byteLength,
        wire,
        opcode: split.opcode,
      };
    } catch (error) {
      return {
        status: "schema-error",
        json: null,
        error: error instanceof Error ? error.message : String(error),
        messageType,
        typeSource,
        payloadBytes: payload.byteLength,
        wire,
        opcode: split.opcode,
      };
    }
  }

  // No schema chosen: report the wire result so the caller can distinguish
  // "not protobuf" from "protobuf we could not name".
  if (wire instanceof WireFormatError) {
    return {
      status: "wire-error",
      json: null,
      error: wire.message,
      messageType: null,
      typeSource: null,
      payloadBytes: payload.byteLength,
      wire,
      opcode: split.opcode,
    };
  }
  return {
    status: "not-attempted",
    json: null,
    error: null,
    messageType: null,
    typeSource: null,
    payloadBytes: payload.byteLength,
    wire,
    opcode: split.opcode,
  };
}

/**
 * Lists message types for the decode picker, nested types included. Map-entry
 * types are excluded: they are compiler artefacts, never a valid root.
 */
export function messageTypeOptions(root: protobuf.Root | null): string[] {
  if (!root) return [];
  return listDecodableTypes(root)
    .map((type) => type.fullName.replace(/^\./, ""))
    .sort();
}

/* ------------------------------------------------------------------ */
/* Wire shape                                                          */
/* ------------------------------------------------------------------ */

/**
 * A structural signature of a payload's wire format: the field numbers and wire
 * types at every level, in order.
 *
 * This is what makes "the same kind of message" meaningful: two frames with the
 * same shape are compatible with the same message types, so a type chosen for
 * one is a sound choice for the other. Values and lengths are excluded on
 * purpose — only the schema-visible structure is compared.
 *
 * Returns null when the payload is not valid protobuf, since there is nothing
 * to generalise.
 */
export function wireShape(bytes: Uint8Array): string | null {
  let parsed;
  try {
    parsed = parseWireFormat(bytes, {
      maxMessageBytes: 16 * 1024 * 1024,
      // Deep enough to distinguish real messages, shallow enough to stay cheap.
      maxDepth: 6,
      maxFields: 500,
      maxNestedBytes: 8 * 1024,
    });
  } catch {
    return null;
  }
  if (parsed.fields.length === 0) return null;
  return describeLevel(parsed.fields, 0);
}

function describeLevel(fields: readonly WireField[], depth: number): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field.kind === "length-delimited" && field.nested && depth < 6) {
      parts.push(`${field.fieldNumber}:2(${describeLevel(field.nested, depth + 1)})`);
    } else if (field.kind === "group" && depth < 6) {
      parts.push(`${field.fieldNumber}:3(${describeLevel(field.fields, depth + 1)})`);
    } else {
      parts.push(`${field.fieldNumber}:${field.wireType}`);
    }
  }
  // Repeated occurrences collapse: {1,1,1,2} must group with {1,2}.
  return [...new Set(parts)].sort().join(",");
}

/* ------------------------------------------------------------------ */
/* Auto-decode rules                                                   */
/* ------------------------------------------------------------------ */

export interface AutoDecodeRuleLike {
  readonly fieldNumber: number;
  readonly fieldValue: number;
  readonly messageType: string;
}

export interface RuleMatch {
  readonly messageType: string;
  readonly rule: AutoDecodeRuleLike;
}

/**
 * Finds the first rule whose field/value pair appears in the payload.
 *
 * Only top-level varint fields are considered, because that is what a numeric
 * discriminator looks like on the wire and what the rule editor describes. A
 * value that appears elsewhere (inside a nested message, or as a string) will
 * not match, which keeps the rule honest about what it inspected.
 */
export function matchAutoDecodeRule(
  bytes: Uint8Array,
  rules: readonly AutoDecodeRuleLike[],
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): RuleMatch | null {
  if (rules.length === 0 || bytes.byteLength === 0) return null;
  let parsed: WireParseResult;
  try {
    parsed = parseWireFormat(bytes, { ...limits, maxNestedBytes: 0 });
  } catch {
    return null;
  }
  for (const rule of rules) {
    const hit = parsed.fields.some(
      (field) =>
        field.kind === "varint" &&
        field.fieldNumber === rule.fieldNumber &&
        field.value.kind === "safe" &&
        field.value.value === rule.fieldValue,
    );
    if (hit) return { messageType: rule.messageType, rule };
  }
  return null;
}
