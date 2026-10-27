import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVELOPE,
  EnvelopeError,
  parseEnvelopeConfig,
  unwrapEnvelope,
  type EnvelopeConfig,
} from "../src/protobuf/envelope";

function config(overrides: Partial<EnvelopeConfig> = {}): EnvelopeConfig {
  return { ...DEFAULT_ENVELOPE, enabled: true, ...overrides };
}

describe("application envelope", () => {
  it("returns the frame unchanged when disabled", () => {
    const frame = new Uint8Array([1, 2, 3]);
    const result = unwrapEnvelope(frame, DEFAULT_ENVELOPE);
    expect(result.payload).toBe(frame);
    expect(result.messageId).toBeNull();
    expect(result.skippedPrefix).toBe(0);
  });

  it("skips a fixed header", () => {
    const frame = new Uint8Array([0xaa, 0xbb, 0x08, 0x05]);
    const result = unwrapEnvelope(frame, config({ headerLength: 2 }));
    expect(result.skippedPrefix).toBe(2);
    expect(Array.from(result.payload)).toEqual([8, 5]);
  });

  it("reads a little-endian uint16 message id", () => {
    const frame = new Uint8Array([0x02, 0x01, 0x08, 0x05]);
    const result = unwrapEnvelope(
      frame,
      config({ headerLength: 2, idEncoding: "uint16le", idOffset: 0, payloadOffset: 2, typeByMessageId: { 258: "game.ChatMessage" } }),
    );
    expect(result.messageId).toBe(258);
    expect(result.messageType).toBe("game.ChatMessage");
    expect(Array.from(result.payload)).toEqual([8, 5]);
  });

  it("reads a big-endian uint32 id at an offset", () => {
    const frame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a, 0x08, 0x01]);
    const result = unwrapEnvelope(
      frame,
      config({ headerLength: 8, idEncoding: "uint32be", idOffset: 4, payloadOffset: 8, typeByMessageId: { 42: "X" } }),
    );
    expect(result.messageId).toBe(42);
    expect(result.messageType).toBe("X");
    expect(Array.from(result.payload)).toEqual([8, 1]);
  });

  it("reads a varint id", () => {
    const frame = new Uint8Array([0xac, 0x02, 0x08, 0x01]);
    const result = unwrapEnvelope(
      frame,
      config({ headerLength: 0, idEncoding: "varint", payloadOffset: 2, typeByMessageId: { 300: "Y" } }),
    );
    expect(result.messageId).toBe(300);
    expect(result.messageType).toBe("Y");
    expect(Array.from(result.payload)).toEqual([8, 1]);
  });

  it("returns a null type for an unmapped id rather than guessing", () => {
    const frame = new Uint8Array([0x07, 0x08, 0x05]);
    const result = unwrapEnvelope(frame, config({ headerLength: 1, idEncoding: "uint8", payloadOffset: 1 }));
    expect(result.messageId).toBe(7);
    expect(result.messageType).toBeNull();
    expect(Array.from(result.payload)).toEqual([8, 5]);
  });

  it("rejects a frame shorter than the configured header", () => {
    expect(() => unwrapEnvelope(new Uint8Array([1]), config({ headerLength: 4 }))).toThrow(EnvelopeError);
    expect(() => unwrapEnvelope(new Uint8Array([1]), config({ headerLength: 4 }))).toThrow(/shorter than the configured/);
  });

  it("rejects a truncated varint id", () => {
    expect(() => unwrapEnvelope(new Uint8Array([0x80]), config({ idEncoding: "varint" }))).toThrow(/Truncated message id/);
  });

  it("rejects a header that cuts through the message id", () => {
    const frame = new Uint8Array([0, 0, 0, 0]);
    expect(() =>
      unwrapEnvelope(frame, config({ headerLength: 1, idEncoding: "uint32le", idOffset: 0, payloadOffset: 1 })),
    ).toThrow(/cuts through the message id/);
  });

  it("rejects an invalid offset configuration", () => {
    expect(() => unwrapEnvelope(new Uint8Array(10), config({ headerLength: -1 }))).toThrow(EnvelopeError);
    expect(() => unwrapEnvelope(new Uint8Array(10), config({ payloadOffset: 999 }))).toThrow(EnvelopeError);
  });
});

describe("envelope config validation", () => {
  it("accepts a well-formed stored config", () => {
    const parsed = parseEnvelopeConfig({
      enabled: true,
      headerLength: 2,
      idEncoding: "uint8",
      idOffset: 0,
      payloadOffset: 3,
      typeByMessageId: { 1: "a.B", 2: "a.C" },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.headerLength).toBe(2);
    expect(parsed.idEncoding).toBe("uint8");
    expect(parsed.typeByMessageId).toEqual({ 1: "a.B", 2: "a.C" });
  });

  it("falls back to the default for junk", () => {
    expect(parseEnvelopeConfig(null)).toEqual(DEFAULT_ENVELOPE);
    expect(parseEnvelopeConfig("nope")).toEqual(DEFAULT_ENVELOPE);
    expect(parseEnvelopeConfig([])).toEqual(DEFAULT_ENVELOPE);
  });

  it("drops unknown id encodings and non-numeric mappings", () => {
    const parsed = parseEnvelopeConfig({
      enabled: true,
      idEncoding: "base64",
      typeByMessageId: { abc: "a.B", "5": "a.C", "6": 7 },
    });
    expect(parsed.idEncoding).toBeUndefined();
    expect(parsed.typeByMessageId).toEqual({ "5": "a.C" });
  });

  it("rejects out-of-range integer fields instead of trusting them", () => {
    const parsed = parseEnvelopeConfig({ enabled: true, headerLength: 10_000, idEncoding: "uint32be", idOffset: 0 });
    expect(parsed.headerLength).toBe(0);
    // A uint32 at offset 0 fits, so the config stays usable.
    expect(parsed.idEncoding).toBe("uint32be");
  });
});
