/* Test harness for the sample server. Deliberately simple: it only builds the
   payloads so that the extension has real traffic to capture. */

(function () {
  "use strict";

  const logEl = document.getElementById("log");
  let socket = null;

  function log(message) {
    logEl.textContent = `${new Date().toISOString()}  ${message}\n${logEl.textContent}`;
  }

  /* Minimal protobuf encoders for the sample messages, so this page has no
     build step of its own. */
  function varint(value) {
    const out = [];
    let v = value >>> 0;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return out;
  }

  function tag(fieldNumber, wireType) {
    return varint(((fieldNumber << 3) | wireType) >>> 0);
  }

  function lengthDelimited(fieldNumber, bytes) {
    return [...tag(fieldNumber, 2), ...varint(bytes.length), ...bytes];
  }

  function utf8(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function encodeLoginRequest(username, password) {
    return new Uint8Array([
      ...lengthDelimited(1, utf8(username)),
      ...lengthDelimited(2, utf8(password)),
      ...tag(3, 0),
      ...varint(7),
      ...tag(4, 0),
      ...varint(2),
    ]);
  }

  function encodeChatMessage(text) {
    return new Uint8Array([
      ...tag(1, 0),
      ...varint(42),
      ...lengthDelimited(2, utf8(text)),
      ...tag(3, 0),
      ...varint(1700000000000 % 0xffffffff),
    ]);
  }

  function openSocket() {
    if (socket && socket.readyState <= 1) return socket;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => log(`open ${url}`);
    socket.onmessage = (event) => {
      const bytes = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
      log(`recv ${typeof event.data === "string" ? "text" : `binary ${bytes.length}B`}`);
    };
    socket.onclose = (event) => log(`closed ${event.code}`);
    socket.onerror = () => log("error");
    return socket;
  }

  function sendLogin() {
    const ws = openSocket();
    const payload = encodeLoginRequest("commander", "hunter2");
    const send = () => {
      ws.send(payload);
      log(`sent LoginRequest ${payload.length}B`);
    };
    if (ws.readyState === 1) send();
    else ws.addEventListener("open", send, { once: true });
  }

  function sendChat() {
    const ws = openSocket();
    const payload = encodeChatMessage("héllo from the test page");
    const send = () => {
      ws.send(payload);
      ws.send("a text frame");
      log(`sent ChatMessage ${payload.length}B`);
    };
    if (ws.readyState === 1) send();
    else ws.addEventListener("open", send, { once: true });
  }

  function sendMalformed() {
    const ws = openSocket();
    const send = () => {
      // A 0x80 tag byte is a continuation-bit tag with no terminator, so the
      // payload cannot be a valid protobuf message.
      ws.send(new Uint8Array([0x80]));
      // Valid in length but the field number is 0, which protobuf forbids.
      ws.send(new Uint8Array([0x00, 0x01]));
      log("sent malformed frames");
    };
    if (ws.readyState === 1) send();
    else ws.addEventListener("open", send, { once: true });
  }

  document.getElementById("connect").addEventListener("click", () => openSocket());
  document.getElementById("login").addEventListener("click", sendLogin);
  document.getElementById("chat").addEventListener("click", sendChat);
  document.getElementById("malformed").addEventListener("click", sendMalformed);

  window.openSocket = openSocket;
  window.sendLogin = sendLogin;
  window.sendChat = sendChat;
  window.sendMalformed = sendMalformed;
  window.protoInspectorTest = { encodeLoginRequest, encodeChatMessage };
})();
