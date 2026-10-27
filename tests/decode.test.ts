import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import { decodeFrame, messageTypeOptions, wireShape } from "../src/panel/decode-service";
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
