/**
 * Extension service worker.
 *
 * Owns `chrome.debugger` attachments and the in-memory capture stores, and is
 * the only place that talks to CDP. The DevTools panel is a thin client over a
 * long-lived port.
 *
 * One session (and therefore one store) exists per inspected tab, so capture
 * can never leak between tabs. All capture state is in memory; if Chrome
 * terminates this worker the state is gone and the panel starts clean.
 */

import { decodeCdpFramePayload } from "../capture/cdp-frames";
import { CaptureStore } from "../capture/store";
import {
  parseFrameErrorEvent,
  parseFrameEvent,
  parseHandshakeRequest,
  parseHandshakeResponse,
  parseWebSocketClosed,
  parseWebSocketCreated,
} from "../capture/targets";
import { bytesToBase64 } from "../shared/bytes";
import type { CapturedFrame, ConnectionInfo } from "../shared/model";
import {
  tabIdFromPortName,
  type CaptureErrorCode,
  type CaptureMode,
  type CaptureStatus,
  type PanelRequest,
  type SnapshotResponse,
  type WorkerEvent,
  type WorkerResponse,
} from "../shared/protocol";
import { looksLikeProtobuf, summarizeWireFields } from "../protobuf/wire";
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "../storage/settings";

const CDP_VERSION = "1.3";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CLOCK_DRIFT_TOLERANCE_MS = 60 * 60 * 1000;

interface TabSession {
  readonly tabId: number;
  readonly store: CaptureStore;
  mode: CaptureMode;
  attached: boolean;
  paused: boolean;
  error: string | null;
  errorCode: CaptureErrorCode | null;
  ports: Set<chrome.runtime.Port>;
  /** Maps CDP's monotonic seconds to wall-clock ms, pinned on first use. */
  timeAnchor: { monotonicMs: number; wallMs: number } | null;
  pageHookActive: boolean;
}

const sessions = new Map<number, TabSession>();
let settings: Settings = DEFAULT_SETTINGS;
let frameCounter = 0;

const settingsReady = loadSettings().then((loaded) => {
  settings = loaded;
  for (const session of sessions.values()) session.store.setRetention(loaded.retentionLimit);
});

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

function getSession(tabId: number): TabSession {
  const existing = sessions.get(tabId);
  if (existing) return existing;
  const store = new CaptureStore();
  store.setRetention(settings.retentionLimit);
  const session: TabSession = {
    tabId,
    store,
    mode: "cdp",
    attached: false,
    paused: false,
    error: null,
    errorCode: null,
    ports: new Set(),
    timeAnchor: null,
    pageHookActive: false,
  };
  sessions.set(tabId, session);
  return session;
}

function statusFor(session: TabSession): CaptureStatus {
  return {
    mode: session.mode,
    attached: session.attached,
    tabId: session.tabId,
    paused: session.paused,
    error: session.error,
    errorCode: session.errorCode,
    framesRetained: session.store.frameCount,
    framesDropped: session.store.droppedFrames,
    retentionLimit: session.store.retention,
    pageHookActive: session.pageHookActive,
  };
}

function post(port: chrome.runtime.Port, message: WorkerEvent | WorkerResponse): void {
  try {
    port.postMessage(message);
  } catch {
    // The panel went away between the snapshot and this event.
  }
}

function broadcast(session: TabSession, event: WorkerEvent): void {
  for (const port of session.ports) post(port, event);
}

function broadcastStatus(session: TabSession): void {
  broadcast(session, { type: "status-changed", status: statusFor(session) });
}

/* ------------------------------------------------------------------ */
/* CDP attach / detach                                                 */
/* ------------------------------------------------------------------ */

function describeAttachError(error: unknown): { message: string; code: CaptureErrorCode } {
  const message = error instanceof Error ? error.message : String(error);
  if (/Another debugger is already attached/i.test(message)) {
    return {
      message:
        "Another debugger is already attached to this tab. Close other DevTools sessions for this tab or detach the other tool, then start capture again.",
      code: "attach-conflict",
    };
  }
  if (/Cannot attach|not allowed|chrome:\/\//i.test(message)) {
    return { message: `This tab cannot be inspected: ${message}`, code: "restricted" };
  }
  if (/No tab with given id|No .* with given id/i.test(message)) {
    return { message: "The inspected tab is no longer available.", code: "tab-gone" };
  }
  return { message, code: "attach-failed" };
}

async function startCdp(session: TabSession): Promise<void> {
  await settingsReady;
  if (session.attached) return;
  try {
    await chrome.debugger.attach({ tabId: session.tabId }, CDP_VERSION);
    session.attached = true;
    session.error = null;
    session.errorCode = null;
    try {
      await chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.enable", {});
    } catch (error) {
      const described = describeAttachError(error);
      session.error = `Debugger attached, but the Network domain could not be enabled: ${described.message}`;
      session.errorCode = "network-enable-failed";
    }
  } catch (error) {
    const described = describeAttachError(error);
    session.attached = false;
    session.error = described.message;
    session.errorCode = described.code;
  }
  broadcastStatus(session);
}

async function stopCdp(session: TabSession): Promise<void> {
  if (!session.attached) return;
  session.attached = false;
  try {
    await chrome.debugger.detach({ tabId: session.tabId });
  } catch {
    // Already detached (tab closed, DevTools took over) — nothing to do.
  }
  broadcastStatus(session);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  session.attached = false;
  if (reason === "target_closed") {
    session.error = "The inspected tab was closed.";
    session.errorCode = "tab-gone";
  } else {
    session.error = `Debugger detached (${String(reason)}). Start capture again to reattach.`;
    session.errorCode = "detached";
  }
  broadcastStatus(session);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  const session = sessions.get(source.tabId);
  if (!session || !session.attached) return;
  handleCdpEvent(session, method, params);
});

/* ------------------------------------------------------------------ */
/* CDP event handling                                                  */
/* ------------------------------------------------------------------ */

function handleCdpEvent(session: TabSession, method: string, params: unknown): void {
  switch (method) {
    case "Network.webSocketCreated": {
      const event = parseWebSocketCreated(params);
      if (!event) return;
      const info: ConnectionInfo = {
        id: event.requestId,
        url: event.url,
        state: "connecting",
        discoveredAt: Date.now(),
        ...(event.initiator?.url ? { initiator: event.initiator.url } : {}),
      };
      const record = session.store.upsertConnection(info);
      broadcast(session, { type: "connection-added", record });
      return;
    }
    case "Network.webSocketWillSendHandshakeRequest": {
      const event = parseHandshakeRequest(params);
      if (!event) return;
      const record = session.store.updateConnection(event.requestId, { state: "connecting" });
      if (record) broadcast(session, { type: "connection-updated", record });
      return;
    }
    case "Network.webSocketHandshakeResponseReceived": {
      const event = parseHandshakeResponse(params);
      if (!event) return;
      const headers = event.response?.headers ?? {};
      const protocol = headers["sec-websocket-protocol"];
      const extensions = headers["sec-websocket-extensions"];
      const record = session.store.updateConnection(event.requestId, {
        state: "open",
        ...(event.response?.status !== undefined ? { handshakeStatus: event.response.status } : {}),
        ...(protocol ? { protocol } : {}),
        ...(extensions ? { extensions } : {}),
      });
      if (record) broadcast(session, { type: "connection-updated", record });
      return;
    }
    case "Network.webSocketFrameSent": {
      const event = parseFrameEvent(params);
      if (!event) return;
      captureFrame(session, event.requestId, "send", event.timestamp, event.response);
      return;
    }
    case "Network.webSocketFrameReceived": {
      const event = parseFrameEvent(params);
      if (!event) return;
      captureFrame(session, event.requestId, "receive", event.timestamp, event.response);
      return;
    }
    case "Network.webSocketFrameError": {
      const event = parseFrameErrorEvent(params);
      if (!event) return;
      const record = session.store.updateConnection(event.requestId, {
        state: "error",
        errorMessage: event.errorMessage,
      });
      if (record) broadcast(session, { type: "connection-updated", record });
      return;
    }
    case "Network.webSocketClosed": {
      const event = parseWebSocketClosed(params);
      if (!event) return;
      const record = session.store.updateConnection(event.requestId, {
        state: "closed",
        closedAt: Date.now(),
      });
      if (record) broadcast(session, { type: "connection-updated", record });
      return;
    }
    default:
      return;
  }
}

/** Converts a CDP monotonic seconds value into wall-clock milliseconds. */
function monotonicToWall(session: TabSession, timestamp: number): number {
  const monotonicMs = timestamp * 1000;
  const now = Date.now();
  if (!session.timeAnchor) session.timeAnchor = { monotonicMs, wallMs: now };
  const estimatedWall = session.timeAnchor.wallMs + (monotonicMs - session.timeAnchor.monotonicMs);
  // Re-anchor when the estimate drifts badly, e.g. after the machine sleeps.
  if (Math.abs(now - estimatedWall) > CLOCK_DRIFT_TOLERANCE_MS) {
    session.timeAnchor = { monotonicMs, wallMs: now };
  }
  return Math.round(session.timeAnchor.wallMs + (monotonicMs - session.timeAnchor.monotonicMs));
}

function captureFrame(
  session: TabSession,
  requestId: string,
  direction: "send" | "receive",
  timestamp: number,
  frame: { opcode: number; mask: boolean; payloadData: string },
): void {
  if (session.paused) return;

  let decoded;
  try {
    decoded = decodeCdpFramePayload(frame);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = session.store.updateConnection(requestId, {
      state: "error",
      errorMessage: `A ${direction === "send" ? "sent" : "received"} frame could not be converted: ${message}`,
    });
    if (record) broadcast(session, { type: "connection-updated", record });
    return;
  }
  if (decoded.bytes.byteLength > MAX_FRAME_BYTES) return;

  if (!session.store.getConnection(requestId)) {
    // A frame can arrive for a connection created before the panel connected.
    session.store.upsertConnection({
      id: requestId,
      url: "(URL not observed)",
      state: "open",
      discoveredAt: Date.now(),
    });
  }

  const protobufLike = decoded.bytes.byteLength > 0 && looksLikeProtobuf(decoded.bytes);
  const summary = protobufLike ? summarizeWireFields(decoded.bytes) : undefined;
  const captured: CapturedFrame = {
    id: `f${++frameCounter}`,
    connectionId: requestId,
    direction,
    kind: decoded.kind,
    timestamp: monotonicToWall(session, timestamp),
    monotonicTime: Math.round(timestamp * 1000),
    bytes: decoded.bytes,
    text: decoded.text,
    opcode: frame.opcode,
    protobufLike,
    ...(summary ? { wireSummary: summary } : {}),
    decodeStatus: decoded.bytes.byteLength === 0 ? "payload-empty" : "not-attempted",
    ...(decoded.note ? { decodeError: decoded.note } : {}),
  };
  const metadata = session.store.addFrame(captured);
  broadcast(session, { type: "frame-added", frame: metadata });
  const record = session.store.updateConnection(requestId, {});
  if (record) broadcast(session, { type: "connection-updated", record });
}

/* ------------------------------------------------------------------ */
/* Port handling                                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  const tabId = tabIdFromPortName(port.name);
  if (tabId === null) return;
  const session = getSession(tabId);
  session.ports.add(port);

  port.onMessage.addListener((message: unknown) => {
    void handleRequest(session, port, message);
  });
  port.onDisconnect.addListener(() => {
    session.ports.delete(port);
    if (session.ports.size === 0) {
      // The last panel for this tab went away (DevTools closed or the panel
      // was reloaded). Release the debugger and drop captured data rather than
      // leaving capture running invisibly in the background.
      void stopCdp(session).then(() => {
        session.store.reset();
        session.pageHookActive = false;
      });
    }
  });

  void settingsReady.then(() => {
    post(port, {
      type: "snapshot",
      status: statusFor(session),
      connections: session.store.listConnections(),
      frames: session.store.listFrames(),
    } satisfies SnapshotResponse);
  });
});

async function handleRequest(session: TabSession, port: chrome.runtime.Port, message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null) return;
  const request = message as PanelRequest;
  switch (request.type) {
    case "start-capture": {
      if (request.mode === "page-hook") {
        session.mode = "page-hook";
        session.pageHookActive = true;
        broadcastStatus(session);
        return;
      }
      session.mode = "cdp";
      await startCdp(session);
      return;
    }
    case "stop-capture": {
      await stopCdp(session);
      return;
    }
    case "pause-capture": {
      session.paused = request.paused;
      broadcastStatus(session);
      return;
    }
    case "clear-capture": {
      session.store.clearFrames();
      broadcast(session, { type: "frames-cleared" });
      broadcastStatus(session);
      return;
    }
    case "set-retention": {
      session.store.setRetention(request.limit);
      settings = { ...settings, retentionLimit: session.store.retention };
      broadcastStatus(session);
      return;
    }
    case "request-status": {
      post(port, { type: "status", status: statusFor(session) });
      return;
    }
    case "request-snapshot": {
      post(port, {
        type: "snapshot",
        status: statusFor(session),
        connections: session.store.listConnections(),
        frames: session.store.listFrames(),
      } satisfies SnapshotResponse);
      return;
    }
    case "request-frame": {
      const stored = session.store.getFrameBytes(request.id);
      if (!stored) return;
      post(port, {
        type: "frame-payload",
        id: request.id,
        base64: bytesToBase64(stored.bytes),
        text: stored.text,
      });
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Tab lifecycle                                                       */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  session.attached = false;
  session.store.reset();
  session.error = "The inspected tab was closed. Reopen the panel on a new tab to capture again.";
  session.errorCode = "tab-gone";
  // Tell the panel why it went quiet before the session disappears, otherwise
  // it would keep showing the last "capturing" status indefinitely.
  for (const port of session.ports) {
    post(port, { type: "capture-reset" });
    post(port, { type: "status-changed", status: statusFor(session) });
  }
  session.ports.clear();
  sessions.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const session = sessions.get(tabId);
  if (!session) return;
  // A navigation replaces the document, so every captured connection is stale.
  session.store.reset();
  session.timeAnchor = null;
  broadcast(session, { type: "capture-reset" });
  broadcastStatus(session);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["protoInspector.settings"]) return;
  void loadSettings().then((loaded) => {
    settings = loaded;
    for (const session of sessions.values()) {
      session.store.setRetention(loaded.retentionLimit);
      broadcastStatus(session);
    }
  });
});
