import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIRE_LIMITS,
  WireFormatError,
  looksLikeProtobuf,
  parseWireFormat,
  summarizeWireFields,
  type WireBytesField,
  type WireField,
  type WireFixed32Field,
  type WireFixed64Field,
  type WireGroupField,
  type WireVarintField,
} from "../src/protobuf/wire";

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function first<T extends WireField>(fields: readonly WireField[]): T {
  const field = fields[0];
  if (!field) throw new Error("expected at least one field");
  return field as T;
}

describe("varint decoding", () => {
  it("decodes a single-byte varint", () => {
    const result = parseWireFormat(bytesFromHex("0805"));
    const field = first<WireVarintField>(result.fields);
    expect(field.fieldNumber).toBe(1);
    expect(field.wireType).toBe(0);
    expect(field.value).toEqual({ kind: "safe", value: 5 });
  });

  it("decodes a multi-byte varint as in the protobuf docs example", () => {
    // Field 1 = 150 => 08 96 01
    const result = parseWireFormat(bytesFromHex("089601"));
    const field = first<WireVarintField>(result.fields);
    expect(field.value).toEqual({ kind: "safe", value: 150 });
  });

  it("keeps 64-bit values exact instead of losing precision", () => {
    // Field 1 = 18446744073709551615 (uint64 max)
    const result = parseWireFormat(bytesFromHex("08ffffffffffffffffff01"));
    const field = first<WireVarintField>(result.fields);
    expect(field.value.kind).toBe("bigint");
    if (field.value.kind !== "bigint") throw new Error("expected bigint");
    expect(field.value.value).toBe(18446744073709551615n);
    expect(field.signed64).toBe(-1n);
  });

  it("rejects a truncated varint", () => {
    expect(() => parseWireFormat(bytesFromHex("0880"))).toThrow(WireFormatError);
    expect(() => parseWireFormat(bytesFromHex("0880"))).toThrow(/Truncated varint/);
  });

  it("rejects a varint longer than ten bytes", () => {
    expect(() => parseWireFormat(bytesFromHex("08ffffffffffffffffffff01"))).toThrow(/longer than 10 bytes/);
  });

  it("computes the signed and zigzag interpretations", () => {
    // 0x7f = 127 => signed 127, zigzag -64
    const result = parseWireFormat(bytesFromHex("087f"));
    const field = first<WireVarintField>(result.fields);
    expect(field.signed64).toBe(127n);
    expect(field.zigzag64).toBe(-64n);
  });
});

describe("field numbers and wire types", () => {
  it("reads the field number and wire type from a tag", () => {
    const result = parseWireFormat(bytesFromHex("1203616263"));
    const field = first<WireBytesField>(result.fields);
    expect(field.fieldNumber).toBe(2);
    expect(field.wireType).toBe(2);
    expect(field.wireTypeName).toBe("length-delimited");
  });

  it("supports large field numbers", () => {
    // Field 536870911 (max), wire type 0: tag = 0xFFFFFFFF... encoded as varint
    const result = parseWireFormat(bytesFromHex("f8ffffff0f01"));
    const field = first<WireVarintField>(result.fields);
    expect(field.fieldNumber).toBe(536_870_911);
    expect(field.value).toEqual({ kind: "safe", value: 1 });
  });

  it("rejects field number zero", () => {
    expect(() => parseWireFormat(bytesFromHex("0001"))).toThrow(/Invalid field number 0/);
  });

  it("rejects an unsupported wire type", () => {
    expect(() => parseWireFormat(bytesFromHex("0e"))).toThrow(/Unsupported wire type 6/);
  });

  it("rejects an unexpected end-group tag", () => {
    expect(() => parseWireFormat(bytesFromHex("0c"))).toThrow(/Unexpected end-group/);
  });
});

describe("length-delimited fields", () => {
  it("reads the payload length and UTF-8 text", () => {
    const result = parseWireFormat(bytesFromHex("1203616263"));
    const field = first<WireBytesField>(result.fields);
    expect(field.length).toBe(3);
    expect(field.utf8).toBe("abc");
    expect(field.byteLength).toBe(5);
  });

  it("reports invalid UTF-8 as null rather than a lossy string", () => {
    const result = parseWireFormat(bytesFromHex("1202fffe"));
    const field = first<WireBytesField>(result.fields);
    expect(field.utf8).toBeNull();
  });

  it("treats a zero-length payload as an empty string", () => {
    const result = parseWireFormat(bytesFromHex("1200"));
    const field = first<WireBytesField>(result.fields);
    expect(field.utf8).toBe("");
    expect(field.nested).toBeNull();
  });

  it("rejects a length that runs past the end of the message", () => {
    expect(() => parseWireFormat(bytesFromHex("0a05abcd"))).toThrow(/Length 5 exceeds remaining 2 bytes/);
  });

  it("parses a nested message when the payload is itself valid protobuf", () => {
    const result = parseWireFormat(bytesFromHex("0a050801120161"));
    const field = first<WireBytesField>(result.fields);
    expect(field.nested).not.toBeNull();
    const nested = field.nested ?? [];
    expect(nested.map((entry) => entry.fieldNumber)).toEqual([1, 2]);
    expect((nested[1] as WireBytesField).utf8).toBe("a");
  });

  it("does not interpret arbitrary bytes as a nested message", () => {
    const result = parseWireFormat(bytesFromHex("1203616263"));
    const field = first<WireBytesField>(result.fields);
    // "abc" is not a valid protobuf message.
    expect(field.nested).toBeNull();
    expect(field.nestedError).not.toBeNull();
  });
});

describe("fixed-width fields", () => {
  it("decodes fixed32 as float and int32", () => {
    const result = parseWireFormat(bytesFromHex("0d0000c03f"));
    const field = first<WireFixed32Field>(result.fields);
    expect(field.asFloat).toBeCloseTo(1.5, 6);
    expect(field.asUint32).toBe(0x3fc00000);
  });

  it("decodes fixed64 as double and int64", () => {
    const result = parseWireFormat(bytesFromHex("11000000000000f03f"));
    const field = first<WireFixed64Field>(result.fields);
    expect(field.asDouble).toBe(1);
    expect(field.raw).toBe(0x3ff0000000000000n);
  });

  it("rejects a truncated fixed32 field", () => {
    expect(() => parseWireFormat(bytesFromHex("0d0000"))).toThrow(/Truncated 4-byte field/);
  });

  it("rejects a truncated fixed64 field", () => {
    expect(() => parseWireFormat(bytesFromHex("1100000000"))).toThrow(/Truncated 8-byte field/);
  });
});

describe("groups", () => {
  it("parses a proto2 group with its inner fields", () => {
    const result = parseWireFormat(bytesFromHex("33380534"));
    const group = first<WireGroupField>(result.fields);
    expect(group.kind).toBe("group");
    expect(group.fieldNumber).toBe(6);
    expect(group.fields).toHaveLength(1);
    expect((group.fields[0] as WireVarintField).value).toEqual({ kind: "safe", value: 5 });
    expect(group.byteLength).toBe(4);
  });

  it("rejects an unterminated group", () => {
    expect(() => parseWireFormat(bytesFromHex("333805"))).toThrow(/Unterminated group/);
  });

  it("rejects a mismatched end-group tag", () => {
    // start group 6, end group 7
    expect(() => parseWireFormat(bytesFromHex("333c"))).toThrow(/Mismatched end-group 7/);
  });
});

describe("limits and malformed input", () => {
  it("rejects messages larger than the byte limit", () => {
    const input = new Uint8Array(64);
    expect(() =>
      parseWireFormat(input, { ...DEFAULT_WIRE_LIMITS, maxMessageBytes: 32 }),
    ).toThrow(/exceeds limit of 32/);
  });

  it("stops at the field limit and reports truncation instead of hanging", () => {
    const fields: number[] = [];
    for (let i = 0; i < 100; i++) fields.push(0x08, 0x01);
    const result = parseWireFormat(bytesFromHex(fields.map((b) => b.toString(16).padStart(2, "0")).join("")), {
      ...DEFAULT_WIRE_LIMITS,
      maxFields: 10,
    });
    expect(result.fields).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/Field limit of 10/);
  });

  it("stops nested interpretation at the depth limit", () => {
    // Two levels of nested length-delimited wrappers; the nested guess is
    // abandoned rather than throwing, so the top-level fields stay visible.
    const inner = bytesFromHex("0801");
    const level1 = new Uint8Array([0x0a, inner.length, ...inner]);
    const level2 = new Uint8Array([0x0a, level1.length, ...level1]);
    const result = parseWireFormat(level2, { ...DEFAULT_WIRE_LIMITS, maxDepth: 1 });
    const outer = first<WireBytesField>(result.fields);
    const inner2 = outer.nested?.[0] as WireBytesField | undefined;
    // The first nesting level is still shown; the next one is refused.
    expect(outer.nested).not.toBeNull();
    expect(inner2?.nested ?? null).toBeNull();
    expect(inner2?.nestedError ?? "").toMatch(/deeper than 1/);
  });

  it("rejects group nesting beyond the depth limit", () => {
    // group 1 starts, group 2 starts, then both end: depth 2 > 1.
    const input = bytesFromHex("0b13140c");
    expect(() => parseWireFormat(input, { ...DEFAULT_WIRE_LIMITS, maxDepth: 1 })).toThrow(/deeper than 1/);
  });

  it("does not attempt nested parsing beyond maxNestedBytes", () => {
    const payload = new Uint8Array(20).fill(0x08);
    const frame = new Uint8Array([0x0a, payload.length, ...payload]);
    const result = parseWireFormat(frame, { ...DEFAULT_WIRE_LIMITS, maxNestedBytes: 4 });
    const field = first<WireBytesField>(result.fields);
    expect(field.nested).toBeNull();
  });

  it("reports the offset of the failure", () => {
    try {
      parseWireFormat(bytesFromHex("08960112ff"));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WireFormatError);
      expect((error as WireFormatError).offset).toBe(4);
    }
  });

  it("accepts an empty payload as zero fields", () => {
    const result = parseWireFormat(new Uint8Array(0));
    expect(result.fields).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("plausibility helpers", () => {
  it("accepts a well-formed message", () => {
    expect(looksLikeProtobuf(bytesFromHex("0896011203616263"))).toBe(true);
  });

  it("rejects random ASCII", () => {
    expect(looksLikeProtobuf(new TextEncoder().encode("hello world"))).toBe(false);
  });

  it("rejects an empty payload", () => {
    expect(looksLikeProtobuf(new Uint8Array(0))).toBe(false);
  });

  it("summarises top-level fields for the message table", () => {
    const summary = summarizeWireFields(bytesFromHex("0896011203616263"));
    expect(summary).toEqual([
      { fieldNumber: 1, wireType: 0, wireTypeName: "varint" },
      { fieldNumber: 2, wireType: 2, wireTypeName: "length-delimited" },
    ]);
  });

  it("returns undefined for a payload it cannot parse", () => {
    expect(summarizeWireFields(bytesFromHex("0a05abcd"))).toBeUndefined();
  });
});
