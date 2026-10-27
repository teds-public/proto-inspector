import { describe, expect, it } from "vitest";
import { decodeCdpFramePayload, frameKindLabel } from "../src/capture/cdp-frames";
import { CaptureStore, clampRetention, MAX_RETENTION, MIN_RETENTION } from "../src/capture/store";
import {
  parseFrameErrorEvent,
  parseFrameEvent,
  parseHandshakeResponse,
  parseWebSocketClosed,
  parseWebSocketCreated,
} from "../src/capture/targets";
import { base64ToBytes, bytesToBase64, hexDump, toHex } from "../src/shared/bytes";
import type { CapturedFrame } from "../src/shared/model";

function frame(opcode: number, payloadData: string) {
  return { opcode, mask: false, payloadData };
}

function capturedFrame(overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    id: "f1",
    connectionId: "c1",
    direction: "receive",
    kind: "binary",
    timestamp: 1_700_000_000_000,
    bytes: new Uint8Array([8, 5]),
    text: null,
    opcode: 2,
    protobufLike: true,
    decodeStatus: "not-attempted",
    ...overrides,
  };
}

describe("CDP frame conversion", () => {
  it("BASE64-decodes binary frames, as CDP documents", () => {
    // CDP sends opcode 2 payloadData as Base64 of the raw bytes.
    const decoded = decodeCdpFramePayload(frame(2, "CJYBEgNhYmM="));
    expect(decoded.kind).toBe("binary");
    expect(Array.from(decoded.bytes)).toEqual([8, 150, 1, 18, 3, 97, 98, 99]);
    expect(decoded.text).toBeNull();
    expect(decoded.lossy).toBe(false);
  });

  it("treats text frames as UTF-8 text, not Base64", () => {
    const decoded = decodeCdpFramePayload(frame(1, "hello"));
    expect(decoded.kind).toBe("text");
    expect(decoded.text).toBe("hello");
    expect(decoded.lossy).toBe(false);
  });

  it("round-trips a text frame containing non-ASCII characters", () => {
    const text = "héllo 🌍";
    const decoded = decodeCdpFramePayload(frame(1, text));
    expect(decoded.text).toBe(text);
    // The bytes are the UTF-8 encoding of the text.
    expect(new TextDecoder().decode(decoded.bytes)).toBe(text);
  });

  it("flags text that may have come from CDP's Latin-1 fallback", () => {
    // C1 control characters cannot occur in valid UTF-8 text, so their
    // presence means the original bytes are not recoverable.
    const decoded = decodeCdpFramePayload(frame(1, "ab"));
    expect(decoded.lossy).toBe(true);
    expect(decoded.note).toMatch(/Latin-1 fallback/);
  });

  it("does not flag ordinary non-ASCII text as lossy", () => {
    const decoded = decodeCdpFramePayload(frame(1, "héllo"));
    expect(decoded.lossy).toBe(false);
    expect(Array.from(decoded.bytes)).toEqual([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
  });

  it("does not misread a Base64-looking text frame as binary", () => {
    const decoded = decodeCdpFramePayload(frame(1, "CJYBEgNhYmM="));
    expect(decoded.kind).toBe("text");
    expect(decoded.text).toBe("CJYBEgNhYmM=");
  });

  it("rejects a binary frame whose payload is not valid Base64", () => {
    expect(() => decodeCdpFramePayload(frame(2, "not base64!!"))).toThrow(/Invalid Base64/);
  });

  it("handles an empty binary frame", () => {
    const decoded = decodeCdpFramePayload(frame(2, ""));
    expect(decoded.bytes.length).toBe(0);
  });

  it("labels opcodes", () => {
    expect(frameKindLabel(1)).toBe("text");
    expect(frameKindLabel(2)).toBe("binary");
    expect(frameKindLabel(8)).toBe("close");
    expect(frameKindLabel(42)).toBe("opcode 42");
  });
});

describe("CDP event parsing", () => {
  it("parses webSocketCreated", () => {
    expect(
      parseWebSocketCreated({ requestId: "1.1", url: "wss://x/y", initiator: { type: "script", url: "https://a/b.js" } }),
    ).toEqual({ requestId: "1.1", url: "wss://x/y", initiator: { type: "script", url: "https://a/b.js" } });
  });

  it("rejects malformed webSocketCreated payloads", () => {
    expect(parseWebSocketCreated({ requestId: 5, url: "wss://x" })).toBeNull();
    expect(parseWebSocketCreated(null)).toBeNull();
    expect(parseWebSocketCreated("nope")).toBeNull();
  });

  it("parses a frame event and requires payloadData", () => {
    expect(
      parseFrameEvent({ requestId: "1", timestamp: 2, response: { opcode: 2, mask: false, payloadData: "AA==" } }),
    ).toEqual({ requestId: "1", timestamp: 2, response: { opcode: 2, mask: false, payloadData: "AA==" } });
    expect(parseFrameEvent({ requestId: "1", timestamp: 2, response: { opcode: 2 } })).toBeNull();
  });

  it("parses frame errors and closures", () => {
    expect(parseFrameErrorEvent({ requestId: "1", timestamp: 2, errorMessage: "boom" })?.errorMessage).toBe("boom");
    expect(parseWebSocketClosed({ requestId: "1", timestamp: 2 })?.requestId).toBe("1");
    expect(parseWebSocketClosed({ requestId: "1" })).toBeNull();
  });

  it("extracts handshake status and headers", () => {
    const parsed = parseHandshakeResponse({
      requestId: "1",
      timestamp: 2,
      response: { status: 101, headers: { "sec-websocket-protocol": "chat", other: 5 } },
    });
    expect(parsed?.response?.status).toBe(101);
    expect(parsed?.response?.headers).toEqual({ "sec-websocket-protocol": "chat" });
  });
});

describe("byte helpers", () => {
  it("round-trips Base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("formats hex", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(toHex(new Uint8Array([1, 2]), " ")).toBe("01 02");
  });

  it("renders a hexdump with offsets and printable ASCII", () => {
    const dump = hexDump(new Uint8Array([0x41, 0x42, 0x00, 0x43]));
    expect(dump).toContain("00000000");
    expect(dump).toContain("AB.C");
  });
});

describe("capture store", () => {
  it("counts sent and received frames per connection", () => {
    const store = new CaptureStore();
    store.upsertConnection({ id: "c1", url: "wss://a", state: "open", discoveredAt: 1 });
    store.addFrame(capturedFrame({ id: "f1", direction: "send" }));
    store.addFrame(capturedFrame({ id: "f2", direction: "receive" }));
    store.addFrame(capturedFrame({ id: "f3", direction: "receive" }));
    const record = store.listConnections()[0];
    expect(record?.sent).toBe(1);
    expect(record?.received).toBe(2);
  });

  it("evicts the oldest frames at the retention limit", () => {
    const store = new CaptureStore();
    store.setRetention(MIN_RETENTION);
    for (let i = 0; i < MIN_RETENTION + 2; i++) store.addFrame(capturedFrame({ id: `f${i}` }));
    expect(store.frameCount).toBe(MIN_RETENTION);
    expect(store.droppedFrames).toBe(2);
    expect(store.hasFrame("f0")).toBe(false);
    expect(store.hasFrame("f1")).toBe(false);
    expect(store.hasFrame(`f${MIN_RETENTION + 1}`)).toBe(true);
    expect(store.listFrames().length).toBe(MIN_RETENTION);
  });

  it("never downgrades a closed connection back to open", () => {
    const store = new CaptureStore();
    store.upsertConnection({ id: "c1", url: "wss://a", state: "open", discoveredAt: 1 });
    store.updateConnection("c1", { state: "closed", closedAt: 9 });
    const record = store.upsertConnection({ id: "c1", url: "wss://a", state: "open", discoveredAt: 1 });
    expect(record.connection.state).toBe("closed");
  });

  it("keeps payload bytes retrievable by id", () => {
    const store = new CaptureStore();
    store.addFrame(capturedFrame({ id: "f9", bytes: new Uint8Array([9, 9, 9]) }));
    expect(Array.from(store.getFrameBytes("f9")?.bytes ?? [])).toEqual([9, 9, 9]);
  });

  it("clears frames but keeps connection records", () => {
    const store = new CaptureStore();
    store.upsertConnection({ id: "c1", url: "wss://a", state: "open", discoveredAt: 1 });
    store.addFrame(capturedFrame());
    store.clearFrames();
    expect(store.frameCount).toBe(0);
    expect(store.listConnections()).toHaveLength(1);
    expect(store.listConnections()[0]?.received).toBe(0);
  });

  it("resets everything", () => {
    const store = new CaptureStore();
    store.upsertConnection({ id: "c1", url: "wss://a", state: "open", discoveredAt: 1 });
    store.addFrame(capturedFrame());
    store.reset();
    expect(store.frameCount).toBe(0);
    expect(store.listConnections()).toEqual([]);
  });

  it("clamps retention into the supported range", () => {
    expect(clampRetention(1)).toBe(MIN_RETENTION);
    expect(clampRetention(Number.MAX_SAFE_INTEGER)).toBe(MAX_RETENTION);
    expect(clampRetention(Number.NaN)).toBe(5000);
  });

  it("returns only the newest frames from listRecentFrames", () => {
    const store = new CaptureStore();
    for (let i = 0; i < 10; i++) store.addFrame(capturedFrame({ id: `f${i}` }));
    expect(store.listRecentFrames(3).map((entry) => entry.id)).toEqual(["f7", "f8", "f9"]);
  });
});
