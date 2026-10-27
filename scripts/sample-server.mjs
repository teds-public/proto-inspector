#!/usr/bin/env node
/**
 * Local integration-test server.
 *
 * Serves a page that opens a WebSocket and exchanges real protobuf messages
 * encoded with protobufjs at runtime, so the extension can be exercised without
 * any production service or game.
 *
 * No WebSocket dependency: the RFC 6455 framing needed for this test (small
 * unmasked server frames, masked client frames) is implemented here directly.
 */

import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1";

async function loadTypes() {
  const rootNs = new protobuf.Root();
  for (const file of ["game.proto", "common.proto"]) {
    protobuf.parse(await readFile(path.join(root, "src", "schemas", file), "utf8"), rootNs, { keepCase: true });
  }
  rootNs.resolveAll();
  return {
    LoginRequest: rootNs.lookupType("game.LoginRequest"),
    LoginResponse: rootNs.lookupType("game.LoginResponse"),
    ChatMessage: rootNs.lookupType("game.ChatMessage"),
  };
}

const types = await loadTypes();

const html = await readFile(path.join(root, "tests", "tab-hook", "index.html"), "utf8");
const appjs = await readFile(path.join(root, "tests", "tab-hook", "app.js"), "utf8");

const server = http.createServer((req, res) => {
  if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(appjs);
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.url === "/fixtures/chat-unicode.bin") {
    const bytes = types.ChatMessage.encode(
      types.ChatMessage.fromObject({
        sender_id: protobuf.util.Long.fromString("42"),
        text: "héllo 🌍",
        sent_at_millis: protobuf.util.Long.fromString("-1"),
        mentions: ["@tester"],
      }),
    ).finish();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(bytes));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.on("upgrade", (req, socket) => {
  if (!req.url?.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.totalLength);
      handleClientMessage(frame);
    }
  });
  socket.on("error", () => socket.destroy());

  function handleClientMessage(frame) {
    if (frame.opcode === 0x8) {
      socket.end();
      return;
    }
    if (frame.opcode === 0x1) {
      socket.write(buildFrame(0x1, Buffer.from(`echo:${frame.payload.toString("utf8")}`)));
      return;
    }
    if (frame.opcode === 0x2) {
      let reply = Buffer.alloc(0);
      try {
        const request = types.LoginRequest.toObject(types.LoginRequest.decode(frame.payload), {
          longs: String,
          enums: Number,
        });
        const response = types.LoginResponse.encode({
          ok: true,
          player: {
            id: protobuf.util.Long.fromString("18446744073709551615"),
            name: `Welcome ${request.username}`,
            class: 1,
            position: { x: 1.25, y: -2.5, z: 0.5 },
            scores: [5, 10, 15],
            avatar: Buffer.from([0, 1, 2, 255]),
            stats: { strength: 12, agility: 7 },
            high_score: protobuf.util.Long.fromString("9223372036854775807", true),
          },
          token: "local-test-token",
        }).finish();
        reply = Buffer.from(response);
      } catch {
        // Not a LoginRequest; fall back to a ChatMessage round trip.
        try {
          const chat = types.ChatMessage.decode(frame.payload);
          reply = Buffer.from(types.ChatMessage.encode(chat).finish());
        } catch {
          reply = Buffer.from(frame.payload);
        }
      }
      // Echo immediately with a small delay so ordering is visible in the UI.
      setTimeout(() => {
        if (!socket.destroyed) socket.write(buildFrame(0x2, reply));
      }, 120);
    }
  }
});

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > 16n * 1024n * 1024n) return null;
    length = Number(big);
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, totalLength: offset + length };
}

function buildFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

server.listen(PORT, HOST, () => {
  console.log(`Proto Inspector sample server: http://${HOST}:${PORT}/`);
  console.log("Open that URL, then use the buttons or the DevTools console:");
  console.log("  openSocket()  /  sendLogin()  /  sendChat()");
});
