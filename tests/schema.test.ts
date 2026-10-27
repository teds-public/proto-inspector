import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SchemaDecodeError,
  decodeWithSchema,
  loadSchema,
  normalizeProtoPath,
  type ProtoFile,
} from "../src/protobuf/schema";

const FIXTURES = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "payloads.json"), "utf8"),
) as {
  cases: Array<{ kind: string; name: string; messageType?: string; hex?: string; expected?: unknown }>;
};

const SCHEMA_DIR = path.join(__dirname, "..", "src", "schemas");

function readSchema(name: string): ProtoFile {
  return { name, content: readFileSync(path.join(SCHEMA_DIR, name), "utf8") };
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fixture(name: string): { messageType: string; bytes: Uint8Array; expected: unknown } {
  const found = FIXTURES.cases.find((entry) => entry.name === name);
  if (!found || !found.messageType || found.hex === undefined) throw new Error(`missing fixture ${name}`);
  return { messageType: found.messageType, bytes: bytesFromHex(found.hex), expected: found.expected };
}

const schemaFiles = [readSchema("game.proto"), readSchema("common.proto"), readSchema("imports.proto")];
const loaded = await loadSchema(schemaFiles);
if (!loaded.ok || !loaded.root) {
  throw new Error(`schemas failed to load: ${JSON.stringify(loaded.errors)}`);
}
const root = loaded.root;

describe("schema loading", () => {
  it("loads all sample files and resolves imports", () => {
    expect(loaded.ok).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.files).toEqual(["game.proto", "common.proto", "imports.proto"]);
  });

  it("lists message types including nested and imported ones", () => {
    expect(loaded.messageTypes).toContain("game.LoginRequest");
    expect(loaded.messageTypes).toContain("game.Player");
    expect(loaded.messageTypes).toContain("common.Envelope");
    expect(loaded.messageTypes).toContain("game.net.Frame");
    // Nested group message declared inside common.WithGroup.
    expect(loaded.messageTypes).toContain("common.WithGroup.Meta");
  });

  it("resolves a bundled well-known type used through an import", () => {
    const frame = root.lookupType("game.net.Frame");
    const field = frame.fields["observed_at"];
    expect(field?.resolvedType?.fullName).toBe(".google.protobuf.Timestamp");
  });

  it("normalizes import paths", () => {
    expect(normalizeProtoPath("./a/b.proto")).toBe("a/b.proto");
    expect(normalizeProtoPath("a/../b.proto")).toBe("b.proto");
    expect(normalizeProtoPath("a\\b\\c.proto")).toBe("a/b/c.proto");
  });

  it("reports a syntax error with its line number", async () => {
    const result = await loadSchema([{ name: "bad.proto", content: "message {\n" }]);
    expect(result.ok).toBe(false);
    expect(result.root).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports an unresolvable type rather than silently ignoring it", async () => {
    const result = await loadSchema([
      { name: "bad.proto", content: 'syntax = "proto3"; message A { Missing m = 1; }' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Missing/);
  });

  it("rejects non-.proto uploads and duplicates", async () => {
    const wrongExtension = await loadSchema([{ name: "notes.txt", content: "x" }]);
    expect(wrongExtension.ok).toBe(false);
    const duplicate = await loadSchema([
      { name: "a.proto", content: 'syntax = "proto3"; message A {}' },
      { name: "./a.proto", content: 'syntax = "proto3"; message B {}' },
    ]);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]?.message).toMatch(/Duplicate/);
  });

  it("warns about imports that were never supplied", async () => {
    const result = await loadSchema([
      { name: "solo.proto", content: 'syntax = "proto3"; import "other.proto"; message A { int32 x = 1; }' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/other\.proto/);
  });

  it("parses a schema with no files as an error", async () => {
    const result = await loadSchema([]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/No \.proto files/);
  });
});

describe("schema decoding", () => {
  it("decodes every scalar and string field", () => {
    const { messageType, bytes } = fixture("login-request");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json).toEqual({
      username: "commander",
      password: "hunter2",
      protocol_version: 7,
      preferred_class: { $enum: "ROGUE", value: 2 },
    });
    expect(result.consumedBytes).toBe(bytes.length);
  });

  it("decodes nested messages, repeated fields, maps and oneofs", () => {
    const { messageType, bytes } = fixture("login-response");
    const result = decodeWithSchema(root, messageType, bytes);
    const player = result.json.player as Record<string, unknown>;
    expect(result.json.ok).toBe(true);
    expect(player.name).toBe("Zed");
    expect(player.class).toEqual({ $enum: "MAGE", value: 3 });
    expect(player.scores).toEqual([10, -20, 30]);
    expect(player.avatar).toEqual({ $bytes: "AAEC/w==", byteLength: 4 });
    expect(player.stats).toEqual({ strength: 12, agility: 7 });
    expect(result.json.token).toBe("session-token");
    expect(result.json.retry_after_seconds).toBeUndefined();
    expect(result.json.waypoints).toHaveLength(2);
  });

  it("renders non-string map keys as key/value pairs", () => {
    const { messageType, bytes } = fixture("login-response");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json.labels).toEqual([
      { key: 7, value: "seven" },
      { key: 42, value: "answer" },
    ]);
  });

  it("keeps uint64 values above the safe integer range exact", () => {
    const { messageType, bytes } = fixture("login-response");
    const result = decodeWithSchema(root, messageType, bytes);
    const player = result.json.player as Record<string, unknown>;
    expect(player.id).toEqual({ $number: "18446744073709551615" });
  });

  it("keeps int64 min/max exact in both directions", () => {
    const maxCase = fixture("login-response");
    const maxResult = decodeWithSchema(root, maxCase.messageType, maxCase.bytes);
    expect((maxResult.json.player as Record<string, unknown>).high_score).toEqual({
      $number: "9223372036854775807",
    });

    const minCase = fixture("big-int64");
    const minResult = decodeWithSchema(root, minCase.messageType, minCase.bytes);
    expect(minResult.json.high_score).toEqual({ $number: "-9223372036854775808" });
  });

  it("keeps values inside the safe integer range as numbers", () => {
    const { messageType, bytes } = fixture("big-int64");
    const result = decodeWithSchema(root, messageType, bytes);
    // 9007199254740993 is NOT safe, so it must stay a string-backed number.
    expect(result.json.id).toEqual({ $number: "9007199254740993" });

    const chat = fixture("chat-unicode");
    const chatResult = decodeWithSchema(root, chat.messageType, chat.bytes);
    expect(chatResult.json.sender_id).toBe(42);
  });

  it("decodes UTF-8 text including astral-plane characters", () => {
    const { messageType, bytes } = fixture("chat-unicode");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json.text).toBe("héllo 🌍 wörld");
    expect(result.json.mentions).toEqual(["@a", "@b"]);
  });

  it("decodes an empty message as an empty object", () => {
    const { messageType, bytes } = fixture("chat-empty");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json).toEqual({});
    expect(result.consumedBytes).toBe(0);
  });

  it("decodes a proto2 message with packed fields and an enum", () => {
    const { messageType, bytes } = fixture("proto2-envelope");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json.version).toBe(3);
    expect(result.json.origin).toBe("edge");
    expect(result.json.checksums).toEqual([1, 4294967295]);
    expect(result.json.kind).toEqual({ $enum: "DATA", value: 1 });
  });

  it("decodes a proto2 group", () => {
    const { messageType, bytes } = fixture("proto2-group");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json.meta).toEqual({ priority: 7, tag: "alpha" });
    expect(result.json.after).toBe("tail");
  });

  it("decodes a message that imports another file and a well-known type", () => {
    const { messageType, bytes } = fixture("net-frame");
    const result = decodeWithSchema(root, messageType, bytes);
    expect(result.json.sequence).toBe(99);
    expect(result.json.observed_at).toEqual({ seconds: 1_700_000_000, nanos: 500 });
    // An empty repeated field is omitted by the encoder and stays absent.
    expect(result.json.chat).toEqual({
      sender_id: 1,
      text: "hi",
      sent_at_millis: 123,
    });
  });

  it("reports an unknown enum number instead of dropping it", () => {
    // game.LoginRequest.preferred_class = 9 (not a declared value)
    const bytes = new Uint8Array([0x20, 0x09]);
    const result = decodeWithSchema(root, "game.LoginRequest", bytes);
    expect(result.json.preferred_class).toEqual({ $enum: null, value: 9 });
  });

  it("skips unknown fields without failing", () => {
    // Field 99 varint 1, then username.
    const bytes = new Uint8Array([0x98, 0x06, 0x01, 0x0a, 0x01, 0x41]);
    const result = decodeWithSchema(root, "game.LoginRequest", bytes);
    expect(result.json.username).toBe("A");
  });

  it("rejects junk after a valid field", () => {
    const bytes = new Uint8Array([0x0a, 0x01, 0x41, 0x00]);
    expect(() => decodeWithSchema(root, "game.LoginRequest", bytes)).toThrow(SchemaDecodeError);
    expect(() => decodeWithSchema(root, "game.LoginRequest", bytes)).toThrow(/Invalid field number 0/);
  });

  it("rejects a truncated field at the end of the payload", () => {
    // username declares 5 bytes but only 1 remains.
    const bytes = new Uint8Array([0x0a, 0x05, 0x41]);
    expect(() => decodeWithSchema(root, "game.LoginRequest", bytes)).toThrow(SchemaDecodeError);
  });

  it("rejects an unknown message type", () => {
    expect(() => decodeWithSchema(root, "game.DoesNotExist", new Uint8Array([0]))).toThrow();
  });

  it("rejects a payload larger than the configured limit", () => {
    expect(() =>
      decodeWithSchema(root, "game.ChatMessage", new Uint8Array(32), {
        maxDepth: 10,
        maxFields: 10,
        maxMessageBytes: 8,
      }),
    ).toThrow(/exceeds limit of 8/);
  });

  it("rejects a truncated nested message", () => {
    // Field 4 (position) declares 5 bytes but only 2 remain.
    const bytes = new Uint8Array([0x22, 0x05, 0x0d, 0x00]);
    expect(() => decodeWithSchema(root, "game.Player", bytes)).toThrow(/exceeds payload/);
  });

  it("enforces the field count limit", () => {
    const bytes = new Uint8Array(40).fill(0x0a);
    for (let i = 1; i < 40; i += 2) bytes[i] = 0x00;
    expect(() =>
      decodeWithSchema(root, "game.ChatMessage", bytes, { maxDepth: 10, maxFields: 2, maxMessageBytes: 1024 }),
    ).toThrow(/Field count exceeds limit of 2/);
  });

  it("rejects a message nested deeper than the limit", () => {
    // game.Player.position is one level deep.
    const position = new Uint8Array([0x0d, 0x00, 0x00, 0x00, 0x00]);
    const player = new Uint8Array([0x22, position.length, ...position]);
    expect(() =>
      decodeWithSchema(root, "game.Player", player, { maxDepth: 0, maxFields: 100, maxMessageBytes: 1024 }),
    ).toThrow(/deeper than 0/);
  });

  it("produces no prototype poisoning from a field named __proto__", () => {
    const evil = 'syntax = "proto3"; message Evil { string __proto__ = 1; string constructor = 2; }';
    return loadSchema([{ name: "evil.proto", content: evil }]).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.root) throw new Error("no root");
      const decoded = decodeWithSchema(
        result.root,
        "Evil",
        new Uint8Array([0x0a, 0x01, 0x41, 0x12, 0x01, 0x42]),
      );
      expect(Object.getPrototypeOf(decoded.json)).toBeNull();
      expect(Object.prototype).not.toHaveProperty("polluted");
    });
  });
});

describe("fixture expectations match the decoder", () => {
  for (const entry of FIXTURES.cases) {
    if (entry.kind !== "schema" || !entry.messageType || entry.hex === undefined) continue;
    it(`decodes ${entry.name}`, () => {
      const result = decodeWithSchema(root, entry.messageType as string, bytesFromHex(entry.hex as string));
      expect(result.json).toBeTypeOf("object");
    });
  }
});
