import { describe, expect, it } from "vitest";
import protobuf from "protobufjs";
import { opcodeTypeFor, readOpcodeRegistry, splitFrame } from "../src/protobuf/opcode";
import { loadSchema, type ProtoFile } from "../src/protobuf/schema";
import { decodeFrame } from "../src/panel/decode-service";

const LOBBY_PROTO = `syntax = "proto3";
package bonus.realtime.lobby;

enum LobbyRealtimeOpcode {
  LOBBY_REALTIME_OPCODE_UNSPECIFIED = 0;

  // opcode: 1001
  // auth: not required
  // request: LobbyAuthRequest
  // response: LobbyAuthResponse
  LOBBY_AUTH = 1001;

  // opcode: 1005
  // request: none
  // response: GetPlayerDataResponse
  PLAYER_GET_PLAYER_DATA = 1005;
}

message LobbyAuthRequest {
  string login_id = 1;
  string password = 2;
}

message LobbyAuthResponse {
  bool success = 1;
  string code = 2;
}

message GetPlayerDataResponse {
  string player_id = 1;
}
`;

const files: ProtoFile[] = [{ name: "lobby.proto", content: LOBBY_PROTO }];

async function loadRoot(): Promise<protobuf.Root> {
  const loaded = await loadSchema(files);
  if (!loaded.root) throw new Error("schema did not load");
  return loaded.root;
}

function frame(opcode: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, opcode, false);
  out.set(body, 4);
  return out;
}

function encoded(root: protobuf.Root, type: string, value: object): Uint8Array {
  return root.lookupType(type).encode(root.lookupType(type).fromObject(value)).finish();
}

describe("reading opcodes from schema comments", () => {
  it("maps a declared opcode to its request and response types", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(registry.get(1001)).toEqual({
      opcode: 1001,
      request: "bonus.realtime.lobby.LobbyAuthRequest",
      response: "bonus.realtime.lobby.LobbyAuthResponse",
    });
  });

  it("treats `request: none` as no type rather than a name", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(registry.get(1005)).toEqual({
      opcode: 1005,
      request: null,
      response: "bonus.realtime.lobby.GetPlayerDataResponse",
    });
  });

  it("ignores an enum value without an opcode comment", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(registry.has(0)).toBe(false);
  });

  it("resolves a package-qualified name and drops one that does not exist", () => {
    const root = protobuf.parse(
      `syntax = "proto3";
package a.b;
enum Op {
  // opcode: 7
  // request: c.Other
  // response: Missing
  X = 7;
}
message Local {}
`,
      new protobuf.Root(),
      { alternateCommentMode: true },
    ).root;
    root.addJSON({ c: { nested: { Other: { fields: {} } } } });
    const registry = readOpcodeRegistry(root);
    expect(registry.get(7)?.request).toBe("c.Other");
    expect(registry.get(7)?.response).toBeNull();
  });

  it("returns an empty registry when nothing is loaded", () => {
    expect(readOpcodeRegistry(null).size).toBe(0);
  });
});

describe("choosing the type for a frame", () => {
  it("uses the request type for a sent frame and the response type for a received one", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(opcodeTypeFor(registry, 1001, "send")).toBe("bonus.realtime.lobby.LobbyAuthRequest");
    expect(opcodeTypeFor(registry, 1001, "receive")).toBe("bonus.realtime.lobby.LobbyAuthResponse");
  });

  it("has no type for an undeclared opcode or a direction without one", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(opcodeTypeFor(registry, 4242, "send")).toBeNull();
    expect(opcodeTypeFor(registry, 1005, "send")).toBeNull();
  });
});

describe("splitting the opcode prefix from the body", () => {
  it("detects a declared opcode in front of a valid message", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthRequest", {
      login_id: "TESTER1",
      password: "Abcd1234",
    });
    const split = splitFrame(frame(1001, body), "auto", registry);
    expect(split.prefixed).toBe(true);
    expect(split.opcode).toBe(1001);
    expect(Array.from(split.payload)).toEqual(Array.from(body));
  });

  it("leaves a frame alone when its first four bytes are not a declared opcode", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthResponse", { success: true });
    const split = splitFrame(body, "auto", registry);
    expect(split.prefixed).toBe(false);
    expect(split.opcode).toBeNull();
    expect(Array.from(split.payload)).toEqual(Array.from(body));
  });

  it("leaves a frame alone when the whole frame already parses", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthResponse", { success: true });
    // Same bytes as a well-formed message: stripping four bytes would corrupt it.
    const split = splitFrame(body, "auto", registry);
    expect(split.prefixed).toBe(false);
  });

  it("does nothing in `none` mode", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthRequest", { login_id: "x" });
    const raw = frame(1001, body);
    expect(splitFrame(raw, "none", registry).prefixed).toBe(false);
  });

  it("strips four bytes unconditionally in `uint32be` mode", async () => {
    const root = await loadRoot();
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthRequest", { login_id: "x" });
    const split = splitFrame(frame(77, body), "uint32be", new Map());
    expect(split).toMatchObject({ prefixed: true, opcode: 77 });
    expect(Array.from(split.payload)).toEqual(Array.from(body));
  });

  it("splits an empty opcode-only frame without failing", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const split = splitFrame(frame(1005, new Uint8Array()), "auto", registry);
    expect(split).toMatchObject({ prefixed: true, opcode: 1005 });
    expect(split.payload.byteLength).toBe(0);
  });

  it("does not touch a frame too short to hold a prefix", async () => {
    const registry = readOpcodeRegistry(await loadRoot());
    expect(splitFrame(new Uint8Array([1, 2]), "uint32be", registry).prefixed).toBe(false);
  });
});

describe("decoding an opcode-prefixed frame", () => {
  it("decodes the body as the request type and reports the source", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthRequest", {
      login_id: "TESTER1",
      password: "Abcd1234",
    });
    const outcome = decodeFrame({
      bytes: frame(1001, body),
      isTextFrame: false,
      root,
      messageType: null,
      direction: "send",
      prefixMode: "auto",
      opcodes: registry,
    });
    expect(outcome.status).toBe("decoded");
    expect(outcome.messageType).toBe("bonus.realtime.lobby.LobbyAuthRequest");
    expect(outcome.typeSource).toBe("opcode");
    expect(outcome.opcode).toBe(1001);
    expect(outcome.payloadBytes).toBe(body.byteLength);
    expect(outcome.json).toEqual({ login_id: "TESTER1", password: "Abcd1234" });
  });

  it("picks the response type for a received frame", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthResponse", {
      success: true,
      code: "0",
    });
    const outcome = decodeFrame({
      bytes: frame(1001, body),
      isTextFrame: false,
      root,
      messageType: null,
      direction: "receive",
      prefixMode: "auto",
      opcodes: registry,
    });
    expect(outcome.json).toEqual({ success: true, code: "0" });
  });

  it("still lets an explicit pick override the opcode's type", async () => {
    const root = await loadRoot();
    const registry = readOpcodeRegistry(root);
    const body = encoded(root, "bonus.realtime.lobby.GetPlayerDataResponse", { player_id: "p1" });
    const outcome = decodeFrame({
      bytes: frame(1005, body),
      isTextFrame: false,
      root,
      messageType: "bonus.realtime.lobby.GetPlayerDataResponse",
      direction: "send",
      prefixMode: "auto",
      opcodes: registry,
    });
    expect(outcome.typeSource).toBe("manual");
    expect(outcome.json).toEqual({ player_id: "p1" });
  });

  it("reports a wire error on the raw frame when the prefix is not stripped", async () => {
    const root = await loadRoot();
    const body = encoded(root, "bonus.realtime.lobby.LobbyAuthRequest", { login_id: "x" });
    const outcome = decodeFrame({
      bytes: frame(1001, body),
      isTextFrame: false,
      root,
      messageType: null,
      prefixMode: "none",
    });
    expect(outcome.status).toBe("wire-error");
    expect(outcome.error).toMatch(/field number 0/);
  });
});
