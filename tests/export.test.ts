import { describe, expect, it } from "vitest";
import { buildExportDocument, formatBytes, formatDuration, formatTime, jsonToText, statusBadge, truncate, type ExportFrame } from "../src/panel/format";
import { doubleToJson, enumToJson, longToJson, bytesToJson } from "../src/protobuf/json-value";
import { validateSettings, DEFAULT_SETTINGS } from "../src/storage/settings";
import { sanitizeProtoFiles, mergeProtoFiles } from "../src/storage/schema-store";

const sampleFrame: ExportFrame = {
  id: "f1",
  connectionId: "c1",
  connectionUrl: "wss://example/ws",
  direction: "receive",
  kind: "binary",
  timestamp: "2026-01-01T00:00:00.000Z",
  size: 4,
  opcode: 2,
  decodeStatus: "decoded",
  messageType: "game.ChatMessage",
  decodeError: null,
  base64: "CAESAg==",
  text: null,
  decoded: { sender_id: 1, text: "hi" },
  wireFields: [
    { fieldNumber: 1, wireType: 0, wireTypeName: "varint" },
    { fieldNumber: 2, wireType: 2, wireTypeName: "length-delimited" },
  ],
};

describe("export document", () => {
  it("wraps frames with format metadata", () => {
    const doc = buildExportDocument([sampleFrame], Date.UTC(2026, 0, 2));
    expect(doc.format).toBe("proto-inspector-export");
    expect(doc.version).toBe(1);
    expect(doc.exportedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(doc.frames).toHaveLength(1);
    expect(doc.note).toMatch(/sensitive/);
  });

  it("serialises to valid JSON with Base64 payloads preserved", () => {
    const doc = buildExportDocument([sampleFrame], 0);
    const roundTripped = JSON.parse(JSON.stringify(doc)) as typeof doc;
    expect(roundTripped.frames[0]?.base64).toBe("CAESAg==");
    expect(roundTripped.frames[0]?.decoded).toEqual({ sender_id: 1, text: "hi" });
    expect(roundTripped.frames[0]?.wireFields?.[0]?.fieldNumber).toBe(1);
  });

  it("exports an empty frame list without failing", () => {
    const doc = buildExportDocument([], 0);
    expect(doc.frames).toEqual([]);
  });

  it("keeps exact 64-bit values in the exported JSON", () => {
    const frame: ExportFrame = { ...sampleFrame, decoded: { id: longToJson(18446744073709551615n) } };
    const exported = buildExportDocument([frame], 0);
    const parsed = JSON.parse(JSON.stringify(exported)) as typeof exported;
    expect(parsed.frames[0]?.decoded).toEqual({ id: { $number: "18446744073709551615" } });
  });
});

describe("lossless JSON projection", () => {
  it("keeps safe integers as numbers", () => {
    expect(longToJson(42n)).toBe(42);
    expect(longToJson(-42n)).toBe(-42);
    expect(longToJson(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("stringifies integers outside the safe range", () => {
    expect(longToJson(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toEqual({ $number: "9007199254740992" });
    expect(longToJson(-9223372036854775808n)).toEqual({ $number: "-9223372036854775808" });
  });

  it("represents non-finite doubles explicitly", () => {
    expect(doubleToJson(1.5)).toBe(1.5);
    expect(doubleToJson(Number.POSITIVE_INFINITY)).toEqual({ $number: "Infinity" });
    expect(doubleToJson(Number.NaN)).toEqual({ $number: "NaN" });
  });

  it("represents bytes as Base64 with a length", () => {
    expect(bytesToJson(new Uint8Array([0, 1, 2]))).toEqual({ $bytes: "AAEC", byteLength: 3 });
  });

  it("represents enums by name and number", () => {
    expect(enumToJson("ROGUE", 2)).toEqual({ $enum: "ROGUE", value: 2 });
    expect(enumToJson(undefined, 99)).toEqual({ $enum: null, value: 99 });
  });
});

describe("formatting", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MiB");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("formats a timestamp with milliseconds", () => {
    const time = new Date(2026, 0, 1, 13, 5, 9, 7).getTime();
    expect(formatTime(time)).toBe("13:05:09.007");
  });

  it("truncates long strings", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("maps decode status to a badge", () => {
    expect(statusBadge("decoded")).toEqual({ label: "decoded", tone: "ok" });
    expect(statusBadge("schema-error").tone).toBe("error");
    expect(statusBadge("not-attempted").tone).toBe("muted");
  });

  it("renders JSON deterministically", () => {
    expect(jsonToText({ a: 1, b: [true, null] })).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}',
    );
  });

  it("does not crash on circular structures", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(jsonToText(circular)).toContain("[circular]");
  });
});

describe("settings validation", () => {
  it("returns defaults for junk", () => {
    expect(validateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings("nope")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps out-of-range retention and depth", () => {
    const result = validateSettings({ retentionLimit: 9_999_999, maxNestedDepth: 500 });
    expect(result.retentionLimit).toBe(50_000);
    expect(result.maxNestedDepth).toBe(64);
  });

  it("keeps a valid configuration", () => {
    const result = validateSettings({
      retentionLimit: 1000,
      autoDecode: false,
      defaultMessageType: " game.ChatMessage ",
      maxNestedDepth: 8,
      envelope: { enabled: true, headerLength: 2 },
    });
    expect(result.retentionLimit).toBe(1000);
    expect(result.autoDecode).toBe(false);
    expect(result.defaultMessageType).toBe("game.ChatMessage");
    expect(result.maxNestedDepth).toBe(8);
    expect(result.envelope.enabled).toBe(true);
  });

  it("treats a blank message type as absent", () => {
    expect(validateSettings({ defaultMessageType: "   " }).defaultMessageType).toBeNull();
  });
});

describe("schema file sanitising", () => {
  it("accepts .proto files", () => {
    const result = sanitizeProtoFiles([{ name: "a.proto", content: "syntax = \"proto3\";" }]);
    expect(result.errors).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it("rejects non-.proto files and malformed entries", () => {
    const result = sanitizeProtoFiles([{ name: "a.txt", content: "x" }, { name: "b.proto" }, 5]);
    expect(result.files).toHaveLength(0);
    expect(result.errors.length).toBe(3);
  });

  it("rejects an oversized file", () => {
    const result = sanitizeProtoFiles([{ name: "big.proto", content: "x".repeat(2 * 1024 * 1024 + 1) }]);
    expect(result.files).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/exceeds/);
  });

  it("rejects non-array input", () => {
    expect(sanitizeProtoFiles({}).files).toEqual([]);
  });

  it("merges by file name, letting newer files replace older ones", () => {
    const merged = mergeProtoFiles(
      [
        { name: "a.proto", content: "old" },
        { name: "b.proto", content: "keep" },
      ],
      [{ name: "a.proto", content: "new" }],
    );
    expect(merged).toEqual([
      { name: "a.proto", content: "new" },
      { name: "b.proto", content: "keep" },
    ]);
  });
});
