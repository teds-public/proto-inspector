/**
 * Panel-side decoding pipeline: envelope → schema (or wire fallback).
 *
 * Kept free of DOM access so it can be unit-tested and reused by the export
 * path. Everything here is synchronous and bounded by the supplied limits.
 */

import protobuf from "protobufjs";
import { DEFAULT_DECODE_LIMITS, decodeWithSchema, type DecodeLimits } from "../protobuf/schema";
import { unwrapEnvelope, type EnvelopeConfig } from "../protobuf/envelope";
import { DEFAULT_WIRE_LIMITS, WireFormatError, parseWireFormat, type WireParseResult, type WireLimits } from "../protobuf/wire";
import type { JsonValue } from "../protobuf/json-value";
import type { DecodeStatus } from "../shared/model";

export interface DecodeRequest {
  readonly bytes: Uint8Array;
  readonly isTextFrame: boolean;
  readonly root: protobuf.Root | null;
  readonly messageType: string | null;
  readonly envelope: EnvelopeConfig;
  readonly wireLimits?: Partial<WireLimits>;
  readonly decodeLimits?: Partial<DecodeLimits>;
}

export interface DecodeOutcome {
  readonly status: DecodeStatus;
  readonly json: JsonValue | null;
  readonly error: string | null;
  readonly messageType: string | null;
  readonly messageId: number | null;
  readonly payloadBytes: number;
  readonly skippedPrefix: number;
  readonly wire: WireParseResult | WireFormatError | null;
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
    messageId: null as number | null,
    payloadBytes: request.bytes.byteLength,
    skippedPrefix: 0,
  };

  if (request.bytes.byteLength === 0) {
    return { ...base, status: "payload-empty", json: null, error: null, wire: null };
  }
  if (request.isTextFrame) {
    return { ...base, status: "skipped-text", json: null, error: null, wire: null };
  }

  let payload: Uint8Array;
  let messageId: number | null = null;
  let messageType = request.messageType;
  let skippedPrefix = 0;
  try {
    const unwrapped = unwrapEnvelope(request.bytes, request.envelope);
    payload = unwrapped.payload;
    messageId = unwrapped.messageId;
    skippedPrefix = unwrapped.skippedPrefix;
    if (unwrapped.messageType) messageType = unwrapped.messageType;
  } catch (error) {
    return {
      ...base,
      status: "wire-error",
      json: null,
      error: error instanceof Error ? error.message : String(error),
      wire: null,
    };
  }

  if (payload.byteLength === 0) {
    return { ...base, status: "payload-empty", json: null, error: null, wire: null, messageId, skippedPrefix };
  }

  const wire = wireOutcome(payload, wireLimits);

  if (request.root && messageType) {
    try {
      const decoded = decodeWithSchema(request.root, messageType, payload, decodeLimits);
      return {
        status: "decoded",
        json: decoded.json as JsonValue,
        error: null,
        messageType: decoded.messageType,
        messageId,
        payloadBytes: payload.byteLength,
        skippedPrefix,
        wire,
      };
    } catch (error) {
      return {
        status: "schema-error",
        json: null,
        error: error instanceof Error ? error.message : String(error),
        messageType,
        messageId,
        payloadBytes: payload.byteLength,
        skippedPrefix,
        wire,
      };
    }
  }

  // No schema selected: report the wire result so the caller can distinguish
  // "not protobuf" from "protobuf we could not name".
  if (wire instanceof WireFormatError) {
    return {
      status: "wire-error",
      json: null,
      error: wire.message,
      messageType: null,
      messageId,
      payloadBytes: payload.byteLength,
      skippedPrefix,
      wire,
    };
  }
  return {
    status: "not-attempted",
    json: null,
    error: null,
    messageType: null,
    messageId,
    payloadBytes: payload.byteLength,
    skippedPrefix,
    wire,
  };
}

/** Lists message types for the decode picker, nested types included. */
export function messageTypeOptions(root: protobuf.Root | null): string[] {
  if (!root) return [];
  const out: string[] = [];
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Type) {
        out.push(nested.fullName.replace(/^\./, ""));
        walk(nested);
      } else if (nested instanceof protobuf.Namespace) {
        walk(nested);
      }
    }
  };
  walk(root);
  return [...new Set(out)].sort();
}
