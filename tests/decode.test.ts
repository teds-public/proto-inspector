import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import {
  decodeFrame,
  matchAutoDecodeRule,
  messageTypeOptions,
  wireShape,
} from "../src/panel/decode-service";
import { validateRules } from "../src/storage/settings";
import { loadSchema, type ProtoFile } from "../src/protobuf/schema";

const SCHEMA_DIR = path.join(__dirname, "..", "src", "schemas");
const readSchema = (name: string): ProtoFile => ({
  name,
  content: readFileSync(path.join(SCHEMA_DIR, name), "utf8"),
});

const loaded = await loadSchema([
  readSchema("game.proto"),
  readSchema("common.proto"),
  readSchema("imports.proto"),
]);
if (!loaded.ok || !loaded.root) throw new Error(`schemas failed to load: ${JSON.stringify(loaded.errors)}`);
const root = loaded.root;

const loginPayload = new Uint8Array([
  0x0a, 0x09, ...new TextEncoder().encode("commander"),
]);

function decode(overrides: Partial<Parameters<typeof decodeFrame>[0]> = {}) {
  return decodeFrame({
    bytes: loginPayload,
    isTextFrame: false,
    root,
    messageType: null,
    ...overrides,
  });
}

describe("decode resolution", () => {
  it("decodes with the type the user picked", () => {
    const outcome = decode({ messageType: "game.LoginRequest" });
    expect(outcome.status).toBe("decoded");
    expect(outcome.typeSource).toBe("manual");
    expect(outcome.messageType).toBe("game.LoginRequest");
    expect(outcome.json).toMatchObject({ username: "commander" });
  });

  it("decodes with a type remembered for the same wire shape", () => {
    const outcome = decode({ rememberedType: "game.LoginRequest" });
    expect(outcome.status).toBe("decoded");
    expect(outcome.typeSource).toBe("remembered");
  });

  it("never guesses a type when none is chosen", () => {
    const outcome = decode();
    expect(outcome.status).toBe("not-attempted");
    expect(outcome.messageType).toBeNull();
    expect(outcome.typeSource).toBeNull();
  });

  it("prefers an explicit choice over a remembered type", () => {
    const outcome = decode({
      messageType: "game.LoginRequest",
      rememberedType: "game.ChatMessage",
    });
    expect(outcome.typeSource).toBe("manual");
    expect(outcome.messageType).toBe("game.LoginRequest");
  });

  it("stops at wire-format level when the schema cannot decode the payload", () => {
    const outcome = decode({ messageType: "game.ChatMessage" });
    expect(outcome.status).toBe("schema-error");
    expect(outcome.json).toBeNull();
    expect(outcome.error).toBeTruthy();
  });

  it("reports invalid protobuf as a wire error", () => {
    const outcome = decode({
      bytes: new TextEncoder().encode("not protobuf at all"),
      messageType: "game.LoginRequest",
    });
    expect(outcome.status).toBe("schema-error");
  });

  it("returns wire output when no type is chosen and the bytes are not protobuf", () => {
    const outcome = decode({
      bytes: new TextEncoder().encode("not protobuf at all"),
    });
    expect(outcome.status).toBe("wire-error");
    expect(outcome.wire).toBeInstanceOf(Error);
  });

  it("ignores text frames rather than treating them as protobuf", () => {
    const outcome = decode({
      bytes: new TextEncoder().encode("hello"),
      isTextFrame: true,
      messageType: "game.LoginRequest",
    });
    expect(outcome.status).toBe("skipped-text");
  });

  it("reports an empty payload", () => {
    expect(decode({ bytes: new Uint8Array(0) }).status).toBe("payload-empty");
  });

  it("does nothing without a schema, even with a type named", () => {
    const outcome = decode({ root: null, messageType: "game.LoginRequest" });
    expect(outcome.status).toBe("not-attempted");
    expect(outcome.messageType).toBeNull();
  });
});

describe("wire shape grouping", () => {
  it("gives messages with the same structure the same shape", () => {
    const a = new Uint8Array([0x08, 0x2a, 0x12, 0x03, 0x61, 0x62, 0x63]);
    const longer = new TextEncoder().encode("a longer one");
    const b = new Uint8Array([0x08, 0x07, 0x12, longer.length, ...longer]);
    expect(wireShape(a)).toBe(wireShape(b));
  });

  it("separates messages with different field numbers", () => {
    expect(wireShape(new Uint8Array([0x08, 0x2a]))).not.toBe(wireShape(new Uint8Array([0x10, 0x2a])));
  });

  it("distinguishes nested structure from an opaque blob", () => {
    expect(wireShape(new Uint8Array([0x0a, 0x02, 0xff, 0xff]))).toBe("1:2");
    expect(wireShape(new Uint8Array([0x0a, 0x05, 0x08, 0x01, 0x12, 0x01, 0x61]))).toBe("1:2(1:0,2:2)");
  });

  it("ignores repetition so a repeated field keeps its shape", () => {
    expect(wireShape(new Uint8Array([0x2a, 0x02, 0x01, 0x02]))).toBe(
      wireShape(new Uint8Array([0x2a, 0x06, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])),
    );
  });

  it("returns null for payloads that are not protobuf", () => {
    expect(wireShape(new TextEncoder().encode("not protobuf"))).toBeNull();
    expect(wireShape(new Uint8Array(0))).toBeNull();
  });
});

describe("type listing", () => {
  it("offers every user message type and no bundled well-known types", () => {
    const options = messageTypeOptions(root);
    expect(options).toContain("game.LoginRequest");
    expect(options).toContain("common.WithGroup.Meta");
    expect(options.some((name) => name.startsWith("google.protobuf."))).toBe(false);
  });

  it("lists types alphabetically with no duplicates", () => {
    const options = messageTypeOptions(root);
    expect([...options].sort()).toEqual(options);
    expect(new Set(options).size).toBe(options.length);
  });

  it("returns nothing without a schema", () => {
    expect(messageTypeOptions(null)).toEqual([]);
  });
});

describe("nested and repeated decoding", () => {
  it("decodes a message with nested messages and repeated fields", () => {
    const tiny = new protobuf.Root();
    protobuf.parse(
      'syntax = "proto3"; package t;' +
        'message Inner { int32 v = 1; }' +
        'message Outer { repeated Inner items = 1; string name = 2; }',
      tiny,
      { keepCase: true },
    );
    tiny.resolveAll();
    // items: [{v:1},{v:2}], name: "x"
    const bytes = new Uint8Array([
      0x0a, 0x02, 0x08, 0x01,
      0x0a, 0x02, 0x08, 0x02,
      0x12, 0x01, 0x78,
    ]);
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root: tiny,
      messageType: "t.Outer",
    });
    expect(outcome.status).toBe("decoded");
    expect(outcome.json).toMatchObject({ items: [{ v: 1 }, { v: 2 }], name: "x" });
  });

  it("enforces the nesting depth limit", () => {
    const tiny = new protobuf.Root();
    protobuf.parse('syntax = "proto3"; package t; message Inner { int32 v = 1; } message Outer { Inner i = 1; }', tiny, {
      keepCase: true,
    });
    tiny.resolveAll();
    const bytes = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root: tiny,
      messageType: "t.Outer",
      decodeLimits: { maxDepth: 0, maxFields: 100, maxMessageBytes: 1024 },
    });
    expect(outcome.status).toBe("schema-error");
    expect(outcome.error).toMatch(/deeper than 0/);
  });

  it("rejects a payload larger than the configured limit", () => {
    const outcome = decode({
      bytes: new Uint8Array(64),
      messageType: "game.LoginRequest",
      decodeLimits: { maxDepth: 10, maxFields: 10, maxMessageBytes: 8 },
    });
    expect(outcome.status).toBe("schema-error");
    expect(outcome.error).toMatch(/exceeds limit/);
  });
});

describe("auto decode rules", () => {
  const loginVarint = new Uint8Array([0x18, 0x07]); // field 3, varint 7
  const chatVarint = new Uint8Array([0x08, 0x2a]); // field 1, varint 42

  const rule = (fieldNumber: number, fieldValue: number, messageType: string) => ({
    fieldNumber,
    fieldValue,
    messageType,
  });

  it("matches a top-level varint field and value", () => {
    const match = matchAutoDecodeRule(loginVarint, [rule(3, 7, "game.LoginRequest")]);
    expect(match?.messageType).toBe("game.LoginRequest");
  });

  it("does not match when the value differs", () => {
    expect(matchAutoDecodeRule(loginVarint, [rule(3, 8, "game.LoginRequest")])).toBeNull();
  });

  it("does not match when the field number differs", () => {
    expect(matchAutoDecodeRule(loginVarint, [rule(4, 7, "game.LoginRequest")])).toBeNull();
  });

  it("ignores a value that appears in a different field", () => {
    // The same number 7 in field 1 must not satisfy a rule aimed at field 3.
    const wrongField = new Uint8Array([0x08, 0x07]);
    expect(matchAutoDecodeRule(wrongField, [rule(3, 7, "game.LoginRequest")])).toBeNull();
  });

  it("uses the first matching rule when several match", () => {
    const match = matchAutoDecodeRule(loginVarint, [
      rule(3, 7, "game.First"),
      rule(3, 7, "game.Second"),
    ]);
    expect(match?.messageType).toBe("game.First");
  });

  it("skips non-matching rules before a matching one", () => {
    const match = matchAutoDecodeRule(loginVarint, [
      rule(3, 99, "game.Nope"),
      rule(3, 7, "game.Yes"),
    ]);
    expect(match?.messageType).toBe("game.Yes");
  });

  it("never matches length-delimited fields, only varints", () => {
    // field 1, length-delimited "A" — a rule for value 65 must not fire.
    const bytes = new Uint8Array([0x0a, 0x01, 0x41]);
    expect(matchAutoDecodeRule(bytes, [rule(1, 65, "game.LoginRequest")])).toBeNull();
  });

  it("returns null for empty input or no rules", () => {
    expect(matchAutoDecodeRule(loginVarint, [])).toBeNull();
    expect(matchAutoDecodeRule(new Uint8Array(0), [rule(3, 7, "x.Y")])).toBeNull();
  });

  it("returns null for bytes that are not protobuf", () => {
    expect(
      matchAutoDecodeRule(new TextEncoder().encode("not protobuf"), [rule(1, 1, "x.Y")]),
    ).toBeNull();
  });

  it("matches when the discriminator is not the first field", () => {
    // field 1 varint 1, then field 3 varint 7
    const bytes = new Uint8Array([0x08, 0x01, 0x18, 0x07]);
    expect(matchAutoDecodeRule(bytes, [rule(3, 7, "game.LoginRequest")])?.messageType).toBe(
      "game.LoginRequest",
    );
  });

  it("does not treat chat traffic as a login when values differ", () => {
    expect(matchAutoDecodeRule(chatVarint, [rule(3, 7, "game.LoginRequest")])).toBeNull();
  });
});

describe("rule resolution order", () => {
  const bytes = new Uint8Array([0x18, 0x07]);

  it("lets a rule decode a frame with no pick", () => {
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root,
      messageType: null,
      ruledType: "game.LoginRequest",
    });
    expect(outcome.status).toBe("decoded");
    expect(outcome.typeSource).toBe("rule");
  });

  it("lets an explicit pick beat a rule", () => {
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root,
      messageType: "game.ChatMessage",
      ruledType: "game.LoginRequest",
    });
    expect(outcome.typeSource).toBe("manual");
    expect(outcome.messageType).toBe("game.ChatMessage");
  });

  it("lets a rule beat a remembered shape", () => {
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root,
      messageType: null,
      ruledType: "game.LoginRequest",
      rememberedType: "game.ChatMessage",
    });
    expect(outcome.typeSource).toBe("rule");
    expect(outcome.messageType).toBe("game.LoginRequest");
  });

  it("falls back to a remembered shape when no rule matches", () => {
    const outcome = decodeFrame({
      bytes,
      isTextFrame: false,
      root,
      messageType: null,
      rememberedType: "game.LoginRequest",
    });
    expect(outcome.typeSource).toBe("remembered");
  });
});

describe("rule validation", () => {
  it("drops malformed rules instead of failing the whole list", () => {
    const rules = validateRules([
      { fieldNumber: 1, fieldValue: 701, messageType: "a.B" },
      { fieldNumber: 0, fieldValue: 1, messageType: "bad.Field" },
      { fieldNumber: 2, fieldValue: -1, messageType: "bad.Negative" },
      { fieldNumber: 3, fieldValue: 1, messageType: "" },
      { fieldNumber: "x", fieldValue: 1, messageType: "bad.Type" },
      null,
      "nope",
    ]);
    expect(rules).toEqual([{ fieldNumber: 1, fieldValue: 701, messageType: "a.B" }]);
  });

  it("keeps only the first rule for a field/value pair", () => {
    const rules = validateRules([
      { fieldNumber: 1, fieldValue: 701, messageType: "a.First" },
      { fieldNumber: 1, fieldValue: 701, messageType: "a.Second" },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.messageType).toBe("a.First");
  });

  it("returns an empty list for junk", () => {
    expect(validateRules(null)).toEqual([]);
    expect(validateRules({})).toEqual([]);
  });
});
