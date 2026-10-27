#!/usr/bin/env node
/**
 * Regenerates tests/fixtures/payloads.json.
 *
 * Payloads are produced with protobufjs' own encoder, which is an independent
 * implementation from the reflection decoder under test, so the fixtures give
 * a real cross-check rather than a round trip through the same code.
 */

import protobuf from "protobufjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "src", "schemas");

async function loadRoot() {
  const rootNs = new protobuf.Root();
  for (const [name, json] of Object.entries(protobuf.common)) {
    if (name === "get") continue;
    if (json?.nested) rootNs.addJSON(json.nested);
  }
  for (const file of ["game.proto", "common.proto", "imports.proto"]) {
    const source = await readFile(path.join(schemaDir, file), "utf8");
    protobuf.parse(source, rootNs, { keepCase: true });
  }
  rootNs.resolveAll();
  return rootNs;
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

const cases = [];

function add(kind, name, messageType, value, extra = {}) {
  cases.push({ kind, name, messageType, value, ...extra });
}

add("schema", "login-request", "game.LoginRequest", {
  username: "commander",
  password: "hunter2",
  protocol_version: 7,
  preferred_class: 2,
});

add("schema", "login-response", "game.LoginResponse", {
  ok: true,
  player: {
    id: "18446744073709551615",
    name: "Zed",
    class: 3,
    position: { x: 1.5, y: -2.25, z: 0 },
    scores: [10, -20, 30],
    avatar: new Uint8Array([0, 1, 2, 255]),
    stats: { strength: 12, agility: 7 },
    high_score: "9223372036854775807",
  },
  waypoints: [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 5 },
  ],
  token: "session-token",
  labels: { 7: "seven", 42: "answer" },
});

add("schema", "login-response-error", "game.LoginResponse", {
  ok: false,
  error_message: "bad credentials",
  retry_after_seconds: 30,
});

add("schema", "chat-empty", "game.ChatMessage", {});

add("schema", "chat-unicode", "game.ChatMessage", {
  sender_id: "42",
  text: "héllo 🌍 wörld",
  sent_at_millis: "-1",
  mentions: ["@a", "@b"],
});

add("schema", "big-int64", "game.Player", {
  id: "9007199254740993",
  high_score: "-9223372036854775808",
});

add("schema", "proto2-envelope", "common.Envelope", {
  version: 3,
  origin: "edge",
  checksums: [1, 4294967295],
  kind: 1,
});

add("schema", "proto2-group", "common.WithGroup", {
  meta: { priority: 7, tag: "alpha" },
  after: "tail",
});

add("schema", "net-frame", "game.net.Frame", {
  sequence: 99,
  observed_at: { seconds: "1700000000", nanos: 500 },
  chat: { sender_id: "1", text: "hi", sent_at_millis: "123", mentions: [] },
});

// Hand-built wire cases for the schema-free parser.
cases.push({
  kind: "wire",
  name: "varints-and-lengths",
  hex: "0896011203616263",
  note: "field 1 varint 150, field 2 bytes 'abc'",
});
cases.push({
  kind: "wire",
  name: "fixed32-fixed64",
  hex: "0d0000c03f1100000000000000f03f",
  note: "field1 fixed32 1.5, field2 fixed64 1.0",
});
cases.push({
  kind: "wire",
  name: "nested",
  hex: "0a050801120161",
  note: "field1 length-delimited containing field1=1, field2='a'",
});
cases.push({
  kind: "wire",
  name: "truncated-varint",
  hex: "0880",
  note: "varint with continuation bit but no terminator",
});
cases.push({
  kind: "wire",
  name: "truncated-length",
  hex: "0a05abcd",
  note: "length says 5 bytes, only 2 present",
});
cases.push({
  kind: "wire",
  name: "field-number-zero",
  hex: "0001",
  note: "tag with field number 0",
});
cases.push({
  kind: "wire",
  name: "unsupported-wire-type",
  hex: "0e",
  note: "wire type 6",
});
cases.push({
  kind: "wire",
  name: "overlong-varint",
  hex: "08ffffffffffffffffffff01",
  note: "11-byte varint",
});
cases.push({
  kind: "wire",
  name: "big-varint",
  hex: "08ffffffffffffffffff01",
  note: "uint64 max",
});
cases.push({
  kind: "wire",
  name: "group",
  hex: "33380534",
  note: "proto2 group field 6 containing field 7 = 5",
});
cases.push({
  kind: "wire",
  name: "unterminated-group",
  hex: "333805",
  note: "group start without end tag",
});

const rootNs = await loadRoot();
const out = [];
for (const entry of cases) {
  if (entry.kind === "wire") {
    out.push({ kind: entry.kind, name: entry.name, hex: entry.hex, note: entry.note });
    continue;
  }
  const type = rootNs.lookupType(entry.messageType);
  // Values are declared with decimal strings so the exact 64-bit digits are
  // visible in review; protobufjs wants Long instances for those fields.
  const value = coerceLongs(type, entry.value);
  const err = type.verify(value);
  if (err) throw new Error(`${entry.name}: ${err}`);
  const bytes = type.encode(value).finish();
  out.push({
    kind: entry.kind,
    name: entry.name,
    messageType: entry.messageType,
    hex: hex(bytes),
    size: bytes.length,
    expected: JSON.parse(JSON.stringify(entry.value, (key, value) => (value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value))),
  });
}

/** Converts decimal strings into Long for 64-bit fields, recursively. */
function coerceLongs(type, value) {
  if (value === null || typeof value !== "object") return value;
  const out = Array.isArray(value) ? [...value] : { ...value };
  for (const field of type.fieldsArray) {
    const raw = out[field.name];
    if (raw === undefined || raw === null) continue;
    const resolved = field.resolvedType;
    if (field.map) {
      if (typeof raw !== "object" || Array.isArray(raw)) continue;
      const mapped = {};
      for (const [key, item] of Object.entries(raw)) {
        const coercedKey = isLongType(field.keyType) ? protobuf.util.Long.fromString(key, true) : key;
        mapped[String(coercedKey)] = resolved instanceof protobuf.Type ? coerceLongs(resolved, item) : item;
      }
      out[field.name] = mapped;
      continue;
    }
    if (resolved instanceof protobuf.Type) {
      out[field.name] = Array.isArray(raw) ? raw.map((item) => coerceLongs(resolved, item)) : coerceLongs(resolved, raw);
      continue;
    }
    if (isLongType(field.type) && typeof raw === "string") {
      const unsigned = field.type.startsWith("u");
      out[field.name] = Array.isArray(raw)
        ? raw.map((item) => protobuf.util.Long.fromString(item, unsigned))
        : protobuf.util.Long.fromString(raw, unsigned);
    }
  }
  return out;
}

function isLongType(type) {
  return ["int64", "uint64", "sint64", "fixed64", "sfixed64"].includes(type);
}

const target = path.join(root, "tests", "fixtures", "payloads.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ generatedBy: "scripts/make-fixtures.mjs", cases: out }, null, 2) + "\n");
console.log(`Wrote ${out.length} fixtures to ${path.relative(root, target)}`);
