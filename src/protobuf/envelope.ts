/**
 * Optional application envelope handling: fixed headers, message ids and the
 * mapping from an id to a protobuf message type.
 *
 * Kept separate from the decoder so that raw protobuf stays the default and no
 * application-specific wrapping is assumed.
 */

export type IdEncoding = "uint8" | "uint16be" | "uint16le" | "uint32be" | "uint32le" | "varint";

export interface EnvelopeConfig {
  readonly enabled: boolean;
  /** Bytes skipped before the message id. */
  readonly headerLength: number;
  /** How the message id is encoded. Undefined when the envelope has no id. */
  readonly idEncoding?: IdEncoding;
  readonly idOffset: number;
  /** Message type name per message id, keyed by the numeric id as a string. */
  readonly typeByMessageId: Readonly<Record<string, string>>;
  /** Extra bytes skipped after the id and header, before the payload. */
  readonly payloadOffset: number;
}

export const DEFAULT_ENVELOPE: EnvelopeConfig = {
  enabled: false,
  headerLength: 0,
  idOffset: 0,
  typeByMessageId: {},
  payloadOffset: 0,
};

export const MAX_ENVELOPE_PREFIX = 64;

export interface EnvelopeResult {
  readonly payload: Uint8Array;
  readonly messageId: number | null;
  readonly messageType: string | null;
  readonly skippedPrefix: number;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function idWidth(encoding: IdEncoding): number {
  switch (encoding) {
    case "uint8":
      return 1;
    case "uint16be":
    case "uint16le":
      return 2;
    case "uint32be":
    case "uint32le":
      return 4;
    case "varint":
      return 0;
  }
}

function readId(view: DataView, offset: number, encoding: IdEncoding): number {
  switch (encoding) {
    case "uint8":
      return view.getUint8(offset);
    case "uint16be":
      return view.getUint16(offset, false);
    case "uint16le":
      return view.getUint16(offset, true);
    case "uint32be":
      return view.getUint32(offset, false);
    case "uint32le":
      return view.getUint32(offset, true);
    case "varint":
      throw new EnvelopeError("internal: varint handled separately");
  }
}

function validateConfig(config: EnvelopeConfig): void {
  if (!Number.isInteger(config.headerLength) || config.headerLength < 0 || config.headerLength > MAX_ENVELOPE_PREFIX) {
    throw new EnvelopeError(`headerLength must be an integer between 0 and ${MAX_ENVELOPE_PREFIX}`);
  }
  if (!Number.isInteger(config.payloadOffset) || config.payloadOffset < 0 || config.payloadOffset > MAX_ENVELOPE_PREFIX) {
    throw new EnvelopeError(`payloadOffset must be an integer between 0 and ${MAX_ENVELOPE_PREFIX}`);
  }
  if (!Number.isInteger(config.idOffset) || config.idOffset < 0 || config.idOffset > MAX_ENVELOPE_PREFIX) {
    throw new EnvelopeError(`idOffset must be an integer between 0 and ${MAX_ENVELOPE_PREFIX}`);
  }
  if (config.idEncoding) {
    const width = idWidth(config.idEncoding);
    if (width > 0 && config.idOffset + width > MAX_ENVELOPE_PREFIX) {
      throw new EnvelopeError("message id extends past the maximum header prefix");
    }
  }
}

/** Applies the envelope to a raw frame, returning the inner protobuf payload. */
export function unwrapEnvelope(frame: Uint8Array, config: EnvelopeConfig): EnvelopeResult {
  if (!config.enabled) {
    return { payload: frame, messageId: null, messageType: null, skippedPrefix: 0 };
  }
  validateConfig(config);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const prefix = Math.max(config.headerLength, config.idOffset, config.payloadOffset);

  let messageId: number | null = null;
  if (config.idEncoding) {
    if (config.idEncoding === "varint") {
      const decoded = readVarintId(frame, config.headerLength);
      messageId = decoded.value;
      const total = Math.max(decoded.nextOffset, config.payloadOffset);
      return finish(frame, total, messageId, config);
    }
    const width = idWidth(config.idEncoding);
    if (config.idOffset + width > frame.byteLength) {
      throw new EnvelopeError(`Frame of ${frame.byteLength} bytes is shorter than the configured message id`);
    }
    messageId = readId(view, config.idOffset, config.idEncoding);
  }

  const headerEnd = Math.max(config.headerLength, config.payloadOffset);
  if (headerEnd > frame.byteLength) {
    throw new EnvelopeError(`Frame of ${frame.byteLength} bytes is shorter than the configured header`);
  }
  if (messageId !== null && config.idOffset + (config.idEncoding ? idWidth(config.idEncoding) : 0) > headerEnd) {
    throw new EnvelopeError("Configured header cuts through the message id");
  }
  void prefix;
  return finish(frame, headerEnd, messageId, config);
}

function finish(
  frame: Uint8Array,
  offset: number,
  messageId: number | null,
  config: EnvelopeConfig,
): EnvelopeResult {
  if (offset > frame.byteLength) {
    throw new EnvelopeError(`Frame of ${frame.byteLength} bytes is shorter than the configured prefix of ${offset}`);
  }
  const type = messageId === null ? null : config.typeByMessageId[String(messageId)] ?? null;
  return { payload: frame.subarray(offset), messageId, messageType: type, skippedPrefix: offset };
}

function readVarintId(frame: Uint8Array, offset: number): { value: number; nextOffset: number } {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const pos = offset + i;
    if (pos >= frame.byteLength) throw new EnvelopeError("Truncated message id varint");
    const byte = frame[pos] ?? 0;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, nextOffset: pos + 1 };
    shift += 7;
  }
  throw new EnvelopeError("Message id varint is longer than 5 bytes");
}

/** Validates a parsed envelope configuration coming from untrusted storage. */
export function parseEnvelopeConfig(raw: unknown): EnvelopeConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_ENVELOPE;
  const record = raw as Record<string, unknown>;
  const idEncodings: readonly string[] = ["uint8", "uint16be", "uint16le", "uint32be", "uint32le", "varint"];
  const idEncoding =
    typeof record.idEncoding === "string" && idEncodings.includes(record.idEncoding)
      ? (record.idEncoding as IdEncoding)
      : undefined;
  const typeByMessageId: Record<string, string> = {};
  const mappings = record.typeByMessageId;
  if (typeof mappings === "object" && mappings !== null) {
    for (const [key, value] of Object.entries(mappings)) {
      if (!/^\d+$/.test(key) || typeof value !== "string" || value.length === 0) continue;
      if (Number(key) > 0xffffffff) continue;
      typeByMessageId[key] = value;
    }
  }
  const int = (value: unknown, fallback: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_ENVELOPE_PREFIX) {
      return fallback;
    }
    return value;
  };
  const config: EnvelopeConfig = {
    enabled: record.enabled === true,
    headerLength: int(record.headerLength, 0),
    idOffset: int(record.idOffset, 0),
    payloadOffset: int(record.payloadOffset, 0),
    typeByMessageId,
    ...(idEncoding ? { idEncoding } : {}),
  };
  try {
    validateConfig(config);
  } catch {
    return DEFAULT_ENVELOPE;
  }
  return config;
}
