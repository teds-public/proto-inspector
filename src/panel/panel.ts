/**
 * DevTools panel controller.
 *
 * The panel is a pure client: it never touches `chrome.debugger`. It keeps the
 * frame metadata stream from the worker, pulls payload bytes on demand, and
 * does all decoding locally.
 *
 * All captured content is inserted with textContent / text nodes — never
 * innerHTML — so a hostile payload cannot inject markup.
 */

import { base64ToBytes, hexDump } from "../shared/bytes";
import type { ConnectionInfo, FrameMetadata } from "../shared/model";
import {
  portNameForTab,
  type CaptureStatus,
  type ConnectionRecord,
  type FramePayloadResponse,
  type PanelRequest,
  type SnapshotResponse,
  type WorkerEvent,
  type WorkerResponse,
} from "../shared/protocol";
import { attachSearchableSelect, refreshSearchableSelect } from "./searchable-select";
import {
  decodeFrame,
  matchAutoDecodeRule,
  messageTypeOptions,
  wireShape,
  type DecodeOutcome,
} from "./decode-service";
import { loadSchema, type ProtoFile, type SchemaLoadResult } from "../protobuf/schema";
import { loadSchemaSet, saveSchemaSet, sanitizeProtoFiles } from "../storage/schema-store";
import {
  loadSettings,
  saveSettings,
  validateRules,
  type AutoDecodeRule,
  type Settings,
} from "../storage/settings";
import { parseWireFormat, wireTypeName, type WireField, type WireParseResult } from "../protobuf/wire";
import {
  buildExportDocument,
  formatBytes,
  formatIso,
  formatTime,
  jsonToText,
  shortConnectionId,
  statusBadge,
  truncate,
  type ExportFrame,
} from "./format";

const MAX_RENDERED_ROWS = 500;
const MAX_WAIT_MS = 10_000;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface PanelState {
  tabId: number | null;
  port: chrome.runtime.Port | null;
  status: CaptureStatus | null;
  connections: Map<string, ConnectionRecord>;
  frames: FrameMetadata[];
  selectedConnectionId: string | null;
  selectedFrameId: string | null;
  payloads: Map<string, FramePayloadResponse>;
  settings: Settings;
  schema: SchemaLoadResult | null;
  protoFiles: ProtoFile[];
  filters: { search: string; connectionId: string; direction: string; status: string };
  activeTab: "general" | "decoded" | "wire" | "hex" | "text" | "diagnostics";
  showNested: boolean;
  /** Message type explicitly chosen per frame, overriding the default. */
  chosenTypes: Map<string, string>;
  /**
   * Message type chosen per wire shape. A decision made for one message is
   * reused for every later message with the same structure.
   */
  typeByShape: Map<string, string>;
  /** Frames the user asked to decode while automatic decoding is off. */
  forcedDecodes: Set<string>;
  /**
   * Decode outcome per frame, keyed by a fingerprint of what determined it.
   * Lets the table show the resolved type without re-running detection on
   * every render.
   */
  outcomes: Map<string, { readonly key: string; readonly outcome: DecodeOutcome }>;
  /** Wire shape per frame, cached because it is recomputed for every row. */
  shapes: Map<string, string | null>;
  renderedRowCount: number;
}

const state: PanelState = {
  tabId: null,
  port: null,
  status: null,
  connections: new Map(),
  frames: [],
  selectedConnectionId: null,
  selectedFrameId: null,
  payloads: new Map(),
  settings: {
    retentionLimit: 500,
    autoDecode: true,
    reusePickedSchema: true,
    autoDecodeRules: [],
    maxNestedDepth: 16,
  },
  schema: null,
  protoFiles: [],
  filters: { search: "", connectionId: "", direction: "", status: "" },
  activeTab: "general",
  showNested: true,
  chosenTypes: new Map(),
  typeByShape: new Map(),
  forcedDecodes: new Set(),
  outcomes: new Map(),
  shapes: new Map(),
  renderedRowCount: 0,
};

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  wireStaticHandlers();
  state.settings = await loadSettings();
  applySettingsToForm();
  const stored = await loadSchemaSet();
  state.protoFiles = [...stored.files];
  await rebuildSchema();
  connectWhenReady();
}

/**
 * The inspected tab id is delivered by the DevTools page. If the panel was
 * already shown before this script finished loading, the event is missed, so
 * fall back to the property the DevTools page sets.
 */
function connectWhenReady(deadline = Date.now() + MAX_WAIT_MS): void {
  const fromWindow = (window as unknown as { protoInspectorTabId?: number }).protoInspectorTabId;
  if (typeof fromWindow === "number") {
    connect(fromWindow);
    return;
  }
  const onTabId = (event: Event): void => {
    const detail = (event as CustomEvent<number>).detail;
    if (typeof detail === "number") {
      window.removeEventListener("proto-inspector:tab-id", onTabId);
      connect(detail);
    }
  };
  window.addEventListener("proto-inspector:tab-id", onTabId);
  if (Date.now() > deadline) {
    showError("Could not determine the inspected tab. Close and reopen the Proto Inspector panel.");
    return;
  }
  window.setTimeout(() => {
    if (state.port === null) connectWhenReady(deadline);
  }, 100);
}

function connect(tabId: number): void {
  if (state.tabId === tabId && state.port) return;
  state.tabId = tabId;
  const port = chrome.runtime.connect({ name: portNameForTab(tabId) });
  state.port = port;
  port.onMessage.addListener((message: unknown) => handleWorkerMessage(message as WorkerResponse | WorkerEvent));
  port.onDisconnect.addListener(() => {
    state.port = null;
    showError("Lost the connection to the extension background worker. Reload the DevTools panel.");
    renderStatus();
  });
  send({ type: "request-snapshot" });
}

function send(request: PanelRequest): void {
  if (!state.port) return;
  try {
    state.port.postMessage(request);
  } catch {
    state.port = null;
  }
}

/* ------------------------------------------------------------------ */
/* Worker messages                                                     */
/* ------------------------------------------------------------------ */

function handleWorkerMessage(message: WorkerResponse | WorkerEvent): void {
  switch (message.type) {
    case "snapshot": {
      applySnapshot(message);
      return;
    }
    case "status":
    case "status-changed": {
      state.status = message.status;
      applyStatusRetention(message.status.retentionLimit);
      renderStatus();
      return;
    }
    case "connection-added":
    case "connection-updated": {
      state.connections.set(message.record.connection.id, message.record);
      if (!state.selectedConnectionId) state.selectedConnectionId = message.record.connection.id;
      renderConnections();
      renderFilterOptions();
      return;
    }
    case "frame-added": {
      state.frames.push(message.frame);
      state.payloads.set(message.payload.id, message.payload);
      trimLocalFrames();
      if (passesFilters(message.frame)) appendRow(message.frame);
      updateMessageCount();
      renderStatus();
      return;
    }
    case "frames-cleared": {
      state.frames = [];
      state.payloads.clear();
      state.chosenTypes.clear();
      state.forcedDecodes.clear();
      state.outcomes.clear();
      state.shapes.clear();
      state.selectedFrameId = null;
      renderMessages();
      renderDetail();
      updateMessageCount();
      renderStatus();
      return;
    }
    case "capture-reset": {
      state.connections.clear();
      state.frames = [];
      state.payloads.clear();
      state.chosenTypes.clear();
      state.forcedDecodes.clear();
      state.selectedConnectionId = null;
      state.selectedFrameId = null;
      renderConnections();
      renderFilterOptions();
      renderMessages();
      renderDetail();
      updateMessageCount();
      renderStatus();
      return;
    }
    case "frame-payload": {
      state.payloads.set(message.id, message);
      // The row could not name a type before its payload arrived.
      refreshRow(message.id);
      if (state.selectedFrameId === message.id) renderDetail();
      return;
    }
    case "error": {
      showError(message.message);
      return;
    }
    default:
      return;
  }
}

function applySnapshot(snapshot: SnapshotResponse): void {
  state.status = snapshot.status;
  state.connections = new Map(snapshot.connections.map((record) => [record.connection.id, record]));
  state.frames = [...snapshot.frames];
  state.payloads.clear();
  state.chosenTypes.clear();
  state.forcedDecodes.clear();
  applyStatusRetention(snapshot.status.retentionLimit);
  if (!state.selectedConnectionId && snapshot.connections.length > 0) {
    state.selectedConnectionId = snapshot.connections[0]?.connection.id ?? null;
  }
  renderConnections();
  renderFilterOptions();
  renderMessages();
  renderStatus();
  renderSchemaSummary();
}

function applyStatusRetention(limit: number): void {
  if (state.settings.retentionLimit !== limit) {
    state.settings = { ...state.settings, retentionLimit: limit };
  }
}

function trimLocalFrames(): void {
  const limit = state.settings.retentionLimit;
  if (state.frames.length > limit) {
    const removed = state.frames.splice(0, state.frames.length - limit);
    for (const frame of removed) {
      state.payloads.delete(frame.id);
      state.chosenTypes.delete(frame.id);
      state.forcedDecodes.delete(frame.id);
      state.outcomes.delete(frame.id);
      state.shapes.delete(frame.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

type PanelView = "capture" | "settings";
type SettingsView = "general" | "decoding" | "picked" | "schemas";

/**
 * Switches the top-level view.
 *
 * Capture keeps running while Settings is open: this is a view switch, not a
 * pause, so nothing about the debugger attachment changes.
 */
function showView(view: PanelView): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".view-tab")) {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  el<HTMLElement>("view-capture").hidden = view !== "capture";
  el<HTMLElement>("view-settings").hidden = view !== "settings";
  if (view === "settings") {
    // The attach notice and capture errors describe the capture view; leaving
    // them above the settings form would be noise. They reappear on return.
    renderStatus();
  }
}

/** Switches between the sections of the Settings tab. */
function showSettingsView(view: SettingsView): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".settings-tab")) {
    const active = tab.dataset.settingsView === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const section of document.querySelectorAll<HTMLElement>(".settings-panel")) {
    section.hidden = section.id !== `settings-view-${view}`;
  }
}

/* ------------------------------------------------------------------ */
/* Status bar                                                          */
/* ------------------------------------------------------------------ */

function renderStatus(): void {
  const status = state.status;
  const dot = el<HTMLSpanElement>("status-dot");
  const text = el<HTMLSpanElement>("status-text");
  const startBtn = el<HTMLButtonElement>("btn-start");
  const stopBtn = el<HTMLButtonElement>("btn-stop");
  const pauseBtn = el<HTMLButtonElement>("btn-pause");
  const banner = el<HTMLDivElement>("error-banner");

  if (!status) {
    dot.dataset.state = "idle";
    text.textContent = "Connecting…";
    startBtn.disabled = true;
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
    banner.hidden = true;
    return;
  }

  if (status.error) {
    dot.dataset.state = "error";
    text.textContent = "Error";
    banner.hidden = false;
    banner.textContent = status.error;
  } else if (status.attached) {
    dot.dataset.state = status.paused ? "paused" : "capturing";
    // Use the local frame count: status events only arrive on state changes,
    // so the worker's counter would lag behind the visible table.
    text.textContent = status.paused ? "Paused" : `Capturing ${state.frames.length} message(s)`;
    banner.hidden = true;
  } else {
    dot.dataset.state = "idle";
    text.textContent = "Idle";
    banner.hidden = true;
  }

  startBtn.disabled = status.attached;
  startBtn.textContent = status.attached ? "Capturing" : "Start capture";
  stopBtn.disabled = !status.attached;
  pauseBtn.disabled = !status.attached;
  pauseBtn.textContent = status.paused ? "Resume" : "Pause";
}

function showError(message: string): void {
  const banner = el<HTMLDivElement>("error-banner");
  banner.hidden = false;
  banner.textContent = message;
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

function renderConnections(): void {
  const list = el<HTMLUListElement>("connection-list");
  const empty = el<HTMLParagraphElement>("connections-empty");
  list.replaceChildren();
  const records = [...state.connections.values()].sort(
    (a, b) => a.connection.discoveredAt - b.connection.discoveredAt,
  );
  empty.hidden = records.length > 0;

  for (const record of records) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "connection";
    if (record.connection.id === state.selectedConnectionId) button.classList.add("is-selected");
    button.addEventListener("click", () => {
      state.selectedConnectionId = record.connection.id;
      state.filters.connectionId = record.connection.id;
      el<HTMLSelectElement>("filter-connection").value = record.connection.id;
      renderConnections();
      renderMessages();
    });

    const url = document.createElement("div");
    url.className = "connection__url";
    url.textContent = record.connection.url;
    url.title = record.connection.url;

    const meta = document.createElement("div");
    meta.className = "connection__meta";
    const stateLabel = document.createElement("span");
    stateLabel.className = "state";
    stateLabel.dataset.state = record.connection.state;
    stateLabel.textContent = connectionStateLabel(record.connection);
    const counts = document.createElement("span");
    counts.textContent = `${record.sent}↑ ${record.received}↓`;
    meta.append(stateLabel, counts);

    button.append(url, meta);
    item.append(button);
    list.append(item);
  }
}

function connectionStateLabel(connection: ConnectionInfo): string {
  if (connection.state === "error" && connection.errorMessage) return "error";
  return connection.state;
}

function renderFilterOptions(): void {
  const select = el<HTMLSelectElement>("filter-connection");
  const current = state.filters.connectionId;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All connections";
  select.append(all);
  for (const record of state.connections.values()) {
    const option = document.createElement("option");
    option.value = record.connection.id;
    option.textContent = truncate(record.connection.url, 48);
    select.append(option);
  }
  select.value = state.connections.has(current) ? current : "";
  state.filters.connectionId = select.value;
  refreshSearchableSelect(select);
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

function passesFilters(frame: FrameMetadata): boolean {
  if (state.filters.connectionId && frame.connectionId !== state.filters.connectionId) return false;
  if (state.filters.direction && frame.direction !== state.filters.direction) return false;
  if (state.filters.status) {
    // The stored decodeStatus is what the worker wrote when the frame arrived,
    // which is always "not-attempted": decoding happens here, on demand. The
    // badge shows the resolved status, so the filter must read the same value
    // or a "decoded" filter could never match anything.
    const status = resolvedDecode(frame)?.status ?? frame.decodeStatus;
    if (status !== state.filters.status) return false;
  }
  const search = state.filters.search.trim().toLowerCase();
  if (!search) return true;
  const haystack = [
    frame.messageType ?? "",
    frame.connectionId,
    state.connections.get(frame.connectionId)?.connection.url ?? "",
    frame.direction,
    frame.kind,
    frame.decodeError ?? "",
    frame.wireSummary?.map((field) => `${field.fieldNumber}:${field.wireTypeName}`).join(" ") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function visibleFrames(): FrameMetadata[] {
  return state.frames.filter(passesFilters);
}

function renderMessages(): void {
  const body = el<HTMLTableSectionElement>("message-body");
  streamingSuspended = false;
  const pinned = isScrolledToBottom();
  body.replaceChildren();
  state.renderedRowCount = 0;
  const frames = visibleFrames();
  // Keep the newest rows and say so, instead of silently truncating.
  const start = Math.max(0, frames.length - MAX_RENDERED_ROWS);
  const slice = frames.slice(start);
  const fragment = document.createDocumentFragment();
  for (const frame of slice) fragment.append(buildRow(frame));
  body.append(fragment);
  state.renderedRowCount = slice.length;
  el<HTMLParagraphElement>("messages-empty").hidden = frames.length > 0;
  updateMessageCount(frames.length, start);
  scrollToBottomIfPinned(pinned);
}

let streamingSuspended = false;

/**
 * Whether the message list was at its bottom when a row arrived.
 *
 * Sticky-bottom only applies while the user is already at the end: scrolling up
 * to read a message must not be undone by the next frame.
 */
function isScrolledToBottom(): boolean {
  const wrap = el<HTMLDivElement>("table-wrap");
  const remaining = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  // A couple of pixels of slack for fractional layout rounding.
  return remaining <= 2;
}

function scrollToBottomIfPinned(pinned: boolean): void {
  if (!pinned) return;
  const wrap = el<HTMLDivElement>("table-wrap");
  wrap.scrollTop = wrap.scrollHeight;
}

function appendRow(frame: FrameMetadata): void {
  const body = el<HTMLTableSectionElement>("message-body");
  if (streamingSuspended) {
    // A filter changed while frames were streaming in. The rendered rows no
    // longer describe the same set, so rebuild once instead of patching.
    streamingSuspended = false;
    renderMessages();
    return;
  }
  // A row can only be appended if it extends the list that is already
  // rendered; anything else (a frame the filters exclude, or an out-of-order
  // arrival) means the view must be rebuilt.
  if (body.childElementCount > 0 && !frameExtendsRenderedTail(frame)) {
    renderMessages();
    return;
  }
  const pinned = isScrolledToBottom();
  body.append(buildRow(frame));
  state.renderedRowCount++;
  while (body.childElementCount > MAX_RENDERED_ROWS) {
    body.firstElementChild?.remove();
  }
  el<HTMLParagraphElement>("messages-empty").hidden = true;
  scrollToBottomIfPinned(pinned);
}

/** True when `frame` is exactly the next frame after the last rendered row. */
function frameExtendsRenderedTail(frame: FrameMetadata): boolean {
  const body = el<HTMLTableSectionElement>("message-body");
  const lastRow = body.lastElementChild as HTMLTableRowElement | null;
  if (!lastRow) return false;
  const lastId = lastRow.dataset.frameId;
  const lastIndex = state.frames.findIndex((entry) => entry.id === lastId);
  const index = state.frames.findIndex((entry) => entry.id === frame.id);
  if (lastIndex < 0 || index !== lastIndex + 1) return false;
  // All frames between the rendered tail and this one must be filtered out.
  for (let i = lastIndex + 1; i < index; i++) {
    const between = state.frames[i];
    if (between && passesFilters(between)) return false;
  }
  return passesFilters(frame);
}

/** Suspends incremental appends until the next renderMessages(). */
function suspendStreaming(): void {
  streamingSuspended = true;
}

/**
 * Decode result for a row, using only already-loaded payloads. Rows never
 * trigger payload fetches of their own; the selected row and the export path
 * do that.
 */
function resolvedDecode(frame: FrameMetadata): DecodeOutcome | null {
  const payload = state.payloads.get(frame.id);
  if (!payload) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload.base64);
  } catch {
    return null;
  }
  return cachedDecode(frame, bytes);
}

function buildRow(frame: FrameMetadata): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.dataset.frameId = frame.id;
  if (frame.id === state.selectedFrameId) row.classList.add("is-selected");
  row.addEventListener("click", () => selectFrame(frame.id));

  const time = document.createElement("td");
  time.className = "col-time";
  time.textContent = formatTime(frame.timestamp);

  const dir = document.createElement("td");
  dir.className = "col-dir";
  const dirLabel = document.createElement("span");
  dirLabel.className = "dir";
  dirLabel.dataset.dir = frame.direction;
  dirLabel.textContent = frame.direction === "send" ? "SEND" : "RECV";
  dir.append(dirLabel);

  const conn = document.createElement("td");
  conn.className = "col-conn";
  conn.textContent = shortConnectionId(frame.connectionId);
  conn.title = state.connections.get(frame.connectionId)?.connection.url ?? frame.connectionId;

  const size = document.createElement("td");
  size.className = "col-size";
  size.textContent = String(frame.size);

  const formatCell = document.createElement("td");
  formatCell.className = "col-format";
  formatCell.textContent = frame.kind;

  const resolved = resolvedDecode(frame);
  const status = document.createElement("td");
  const badge = statusBadge(resolved?.status ?? frame.decodeStatus);
  const badgeEl = document.createElement("span");
  badgeEl.className = "badge";
  badgeEl.dataset.tone = badge.tone;
  badgeEl.textContent = badge.label;
  status.append(badgeEl);

  const type = document.createElement("td");
  const typeName = resolved?.messageType ?? frame.messageType ?? null;
  type.textContent = typeName ?? (frame.protobufLike ? "—" : "");
  if (typeName) {
    if (resolved?.typeSource === "manual") {
      type.title = `${typeName} (chosen by you)`;
      type.className = "type--chosen";
    } else if (resolved?.typeSource === "rule") {
      type.title = `${typeName} (auto decode rule)`;
      type.className = "type--rule";
    } else if (resolved?.typeSource === "remembered") {
      type.title = `${typeName} (reused for this message shape)`;
      type.className = "type--remembered";
    } else {
      type.title = typeName;
    }
  }

  row.append(time, dir, conn, size, formatCell, status, type);
  return row;
}

function updateMessageCount(visible = visibleFrames().length, start = 0): void {
  const total = state.frames.length;
  const dropped = state.status?.framesDropped ?? 0;
  const shown = Math.max(0, visible - start);
  const parts = [`${visible} / ${total} shown`];
  if (shown < visible) parts.push(`rendering last ${shown}`);
  if (dropped > 0) parts.push(`${dropped} evicted by retention limit`);
  el<HTMLSpanElement>("message-count").textContent = parts.join(" · ");
}

/** Replaces one rendered row in place, preserving selection and scroll. */
function refreshRow(id: string): void {
  const frame = state.frames.find((candidate) => candidate.id === id);
  const row = el<HTMLTableSectionElement>("message-body").querySelector<HTMLTableRowElement>(
    `tr[data-frame-id="${id}"]`,
  );
  if (!frame || !row) return;
  const replacement = buildRow(frame);
  replacement.classList.toggle("is-selected", frame.id === state.selectedFrameId);
  row.replaceWith(replacement);
}

function selectFrame(id: string): void {
  state.selectedFrameId = id;
  for (const row of el<HTMLTableSectionElement>("message-body").querySelectorAll("tr")) {
    row.classList.toggle("is-selected", (row as HTMLTableRowElement).dataset.frameId === id);
  }
  const frame = state.frames.find((candidate) => candidate.id === id);
  if (frame) state.selectedConnectionId = frame.connectionId;
  send({ type: "request-frame", id });
  renderDetail();
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function selectedFrame(): FrameMetadata | null {
  if (!state.selectedFrameId) return null;
  return state.frames.find((frame) => frame.id === state.selectedFrameId) ?? null;
}

function renderDetail(): void {
  const frame = selectedFrame();
  const empty = el<HTMLParagraphElement>("detail-empty");
  const content = el<HTMLDivElement>("detail-content");
  const copyBtn = el<HTMLButtonElement>("btn-copy");
  if (!frame) {
    empty.hidden = false;
    content.hidden = true;
    copyBtn.disabled = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  copyBtn.disabled = false;
  renderMeta(frame);
  renderDecodeTypeOptions(frame);
  renderActiveTab(frame);
}

function renderMeta(frame: FrameMetadata): void {
  const meta = el<HTMLDListElement>("detail-meta");
  meta.replaceChildren();
  const connection = state.connections.get(frame.connectionId)?.connection;
  addMeta(meta, "Time", `${formatIso(frame.timestamp)} (${formatTime(frame.timestamp)})`);
  addMeta(meta, "Direction", frame.direction === "send" ? "SEND (page → server)" : "RECEIVE (server → page)");
  addMeta(meta, "Connection", connection?.url ?? frame.connectionId);
  addMeta(meta, "Size", `${frame.size} bytes (${formatBytes(frame.size)})`);
  addMeta(meta, "Frame", `${frame.kind} (opcode ${frame.opcode})`);
  if (frame.messageType) addMeta(meta, "Message type", frame.messageType);
  if (frame.wireSummary?.length) {
    addMeta(
      meta,
      "Wire fields",
      frame.wireSummary.map((field) => `#${field.fieldNumber} ${field.wireTypeName}`).join(", "),
    );
  }
  if (frame.decodeError) addMeta(meta, "Note", frame.decodeError);
}

function addMeta(list: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function payloadBytes(frame: FrameMetadata): Uint8Array | null {
  const payload = state.payloads.get(frame.id);
  if (!payload) return null;
  try {
    return base64ToBytes(payload.base64);
  } catch {
    return null;
  }
}

function renderDecodeTypeOptions(frame: FrameMetadata): void {
  const select = el<HTMLSelectElement>("decode-type-select");
  const options = messageTypeOptions(state.schema?.root ?? null);

  // What to show: a choice made for this frame, else the type reused for its
  // wire shape, else whatever was decoded. Nothing is guessed.
  const preferred =
    chosenTypeFor(frame) ?? rememberedTypeFor(frame) ?? frame.messageType ?? "";

  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No schema (wire format only)";
  select.append(none);
  for (const type of options) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    select.append(option);
  }
  if (preferred && !options.includes(preferred)) {
    const option = document.createElement("option");
    option.value = preferred;
    option.textContent = `${preferred} (not in the loaded schemas)`;
    select.append(option);
  }
  select.value = preferred;
  // The option list is rebuilt on every frame change, so the search layer is
  // reinstalled to match it.
  refreshSearchableSelect(select);
}


function renderActiveTab(frame: FrameMetadata): void {
  for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) {
    panel.hidden = panel.dataset.panel !== state.activeTab;
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    const active = tab.dataset.tab === state.activeTab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }

  const bytes = payloadBytes(frame);
  const waiting = bytes === null;

  switch (state.activeTab) {
    case "general":
      // Metadata is rendered by renderMeta; only visibility is at stake here.
      return;
    case "decoded":
      renderDecodedTab(frame, bytes, waiting);
      return;
    case "wire":
      renderWireTab(bytes, waiting);
      return;
    case "hex":
      renderHexTab(bytes, waiting);
      return;
    case "text":
      renderTextTab(frame, bytes, waiting);
      return;
    case "diagnostics":
      renderDiagnosticsTab(frame, bytes);
      return;
  }
}

/** A type the user picked for this exact frame. */
function chosenTypeFor(frame: FrameMetadata): string | null {
  return state.chosenTypes.get(frame.id) ?? null;
}

/**
 * A type the user picked for a different frame with the same wire shape,
 * when reuse is enabled. Passed separately from `chosenTypeFor` so the UI can
 * say which of the two applied.
 */
function rememberedTypeFor(frame: FrameMetadata): string | null {
  if (!state.settings.reusePickedSchema) return null;
  const shape = shapeOf(frame);
  if (!shape) return null;
  return state.typeByShape.get(shape) ?? null;
}

/** Changes whenever the inputs that decide a decode change. */
function decodeCacheKey(frame: FrameMetadata): string {
  return [
    frame.id,
    state.chosenTypes.get(frame.id) ?? "",
    state.typeByShape.get(shapeOf(frame) ?? "") ?? "",
    String(state.settings.reusePickedSchema),
    state.schema?.files.join(",") ?? "",
    frame.kind,
  ].join("|");
}

function cachedDecode(frame: FrameMetadata, bytes: Uint8Array): DecodeOutcome {
  const key = decodeCacheKey(frame);
  const hit = state.outcomes.get(frame.id);
  if (hit && hit.key === key) return hit.outcome;
  const outcome = currentDecode(frame, bytes);
  state.outcomes.set(frame.id, { key, outcome });
  return outcome;
}

/** The schema an auto-decode rule selects for this payload, if any. */
function ruledTypeFor(frame: FrameMetadata, bytes: Uint8Array): string | null {
  const rules = state.settings.autoDecodeRules;
  if (rules.length === 0 || frame.kind === "text") return null;
  const match = matchAutoDecodeRule(bytes, rules, {
    maxMessageBytes: 16 * 1024 * 1024,
    maxDepth: 1,
    maxFields: 500,
    maxNestedBytes: 0,
  });
  return match?.messageType ?? null;
}

function currentDecode(frame: FrameMetadata, bytes: Uint8Array): DecodeOutcome {
  return decodeFrame({
    bytes,
    isTextFrame: frame.kind === "text",
    root: state.schema?.root ?? null,
    messageType: chosenTypeFor(frame),
    ruledType: ruledTypeFor(frame, bytes),
    rememberedType: rememberedTypeFor(frame),
    wireLimits: { maxDepth: state.settings.maxNestedDepth },
  });
}

/** Cached wire shape for a frame, or null when its payload is not loaded. */
function shapeOf(frame: FrameMetadata): string | null {
  const cached = state.shapes.get(frame.id);
  if (cached !== undefined) return cached;
  const payload = state.payloads.get(frame.id);
  if (!payload) return null;
  let shape: string | null = null;
  try {
    shape = wireShape(base64ToBytes(payload.base64));
  } catch {
    shape = null;
  }
  state.shapes.set(frame.id, shape);
  return shape;
}

const TYPE_SOURCE_LABEL: Record<NonNullable<DecodeOutcome["typeSource"]>, string> = {
  manual: "chosen by you",
  rule: "matched an auto decode rule",
  remembered: "reused for this message shape",
};

function renderTypeSource(outcome: DecodeOutcome | null): void {
  const label = el<HTMLParagraphElement>("type-source");
  if (!outcome || !outcome.messageType || !outcome.typeSource) {
    label.hidden = true;
    label.textContent = "";
    return;
  }
  label.hidden = false;
  label.dataset.source = outcome.typeSource;
  const parts = [`Type: ${outcome.messageType} — ${TYPE_SOURCE_LABEL[outcome.typeSource]}`];
  if (outcome.typeSource === "remembered") {
    parts.push("applies to messages with the same shape");
  }
  label.textContent = parts.join(" · ");
  // Always reflect the type actually used. Clearing this for a manual choice
  // left the picker on "No schema" while the JSON beside it was decoded.
  syncTypePicker(outcome.messageType);
}

/**
 * Keeps the picker showing the type that was actually used.
 *
 * Clears it when `messageType` is null: an ambiguous frame has no single
 * answer, and naming one in the picker would contradict the warning above.
 */
function syncTypePicker(messageType: string | null): void {
  const select = el<HTMLSelectElement>("decode-type-select");
  if (!messageType) {
    select.value = "";
    return;
  }
  let option = Array.from(select.options).find((candidate) => candidate.value === messageType);
  if (!option) {
    option = document.createElement("option");
    option.value = messageType;
    option.textContent = messageType;
    select.append(option);
  }
  select.value = messageType;
}

function renderDecodedTab(frame: FrameMetadata, bytes: Uint8Array | null, waiting: boolean): void {
  const output = el<HTMLPreElement>("decoded-output");
  if (waiting) {
    renderTypeSource(null);
    output.textContent = "Loading payload…";
    return;
  }
  if (frame.kind === "text") {
    renderTypeSource(null);
    const text = state.payloads.get(frame.id)?.text ?? null;
    output.textContent = text === null
      ? "This is a text frame."
      : `This is a text frame; schema decoding does not apply.\n\n${text}`;
    return;
  }
  if (bytes === null) {
    renderTypeSource(null);
    output.textContent = "The payload is no longer available (it may have been evicted).";
    return;
  }
  const autoDecode = state.settings.autoDecode || state.forcedDecodes.has(frame.id);
  if (!autoDecode && !state.chosenTypes.has(frame.id)) {
    renderTypeSource(null);
    output.textContent =
      "Automatic decoding is off. Choose a message type and press Decode to inspect this payload.";
    return;
  }
  const outcome = cachedDecode(frame, bytes);
  renderTypeSource(outcome);
  if (outcome.status === "decoded") {
    output.replaceChildren(...highlightJson(outcome.json));
    return;
  }
  if (outcome.status === "schema-error") {
    // Distinguish "wrong message type" from "these bytes are not protobuf at
    // all", so the suggested fix is the right one.
    const wireFailed = outcome.wire instanceof Error;
    output.textContent = wireFailed
      ? `This payload is not valid protobuf, so no message type can decode it.\n\nWire parser: ${outcome.wire instanceof Error ? outcome.wire.message : ""}\n\nUse the Hex tab to inspect the raw bytes.`
      : `Schema decoding failed: ${outcome.error ?? "unknown error"}\n\nSelect a different message type, or open the Wire tab to inspect the raw fields.`;
    return;
  }
  if (outcome.status === "payload-empty") {
    output.textContent = "The payload is empty.";
    return;
  }
  if (outcome.status === "wire-error") {
    output.textContent = `This payload is not valid protobuf: ${outcome.error ?? "unknown error"}\n\nUse the Hex tab to inspect the raw bytes.`;
    return;
  }
  output.textContent =
    "No message type selected. Import a .proto file, choose a message type above and press Decode — " +
    "or open the Wire tab for a schema-free view.";
}

function renderWireTab(bytes: Uint8Array | null, waiting: boolean): void {
  const output = el<HTMLDivElement>("wire-output");
  output.replaceChildren();
  if (waiting) {
    output.textContent = "Loading payload…";
    return;
  }
  if (bytes === null) {
    output.textContent = "The payload is no longer available (it may have been evicted).";
    return;
  }
  if (bytes.byteLength === 0) {
    output.textContent = "The payload is empty.";
    return;
  }
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "Schema-free view. Field numbers and wire types are exact; names, meaning and nested " +
    "structure are inferences and may be wrong.";
  output.append(note);

  let parsed: WireParseResult;
  try {
    parsed = parseWireFormat(bytes, { maxMessageBytes: 16 * 1024 * 1024, maxDepth: state.settings.maxNestedDepth, maxFields: 10_000, maxNestedBytes: 64 * 1024 });
  } catch (error) {
    const problem = document.createElement("p");
    problem.className = "diagnostic--error";
    problem.textContent = `Not valid protobuf: ${error instanceof Error ? error.message : String(error)}`;
    output.append(problem);
    return;
  }
  const list = document.createElement("div");
  for (const field of parsed.fields) list.append(renderWireField(field, 0));
  output.append(list);
  if (parsed.truncated) {
    const truncatedEl = document.createElement("p");
    truncatedEl.className = "wire-note";
    truncatedEl.textContent = parsed.truncatedReason ?? "Decoding stopped early.";
    output.append(truncatedEl);
  }
}

function renderWireField(field: WireField, depth: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "wire-field";
  const head = document.createElement("div");
  head.className = "wire-field__head";

  const num = document.createElement("span");
  num.className = "wire-field__num";
  num.textContent = `#${field.fieldNumber}`;
  const type = document.createElement("span");
  type.className = "wire-field__type";
  type.textContent = `${wireTypeName(field.wireType)} · ${field.byteLength}B @${field.byteOffset}`;
  const value = document.createElement("span");
  value.className = "wire-field__value";
  value.textContent = describeWireValue(field);
  head.append(num, type, value);
  wrapper.append(head);

  if (state.showNested && field.kind === "length-delimited" && field.nested && depth < 4) {
    const nested = document.createElement("div");
    nested.className = "wire-nested";
    for (const child of field.nested) nested.append(renderWireField(child, depth + 1));
    if (field.nestedTruncated) {
      const note = document.createElement("div");
      note.className = "wire-note";
      note.textContent = "Nested interpretation stopped at a limit.";
      nested.append(note);
    }
    wrapper.append(nested);
  } else if (field.kind === "length-delimited" && field.nestedError && depth === 0 && field.utf8 === null) {
    // Only worth saying for non-text payloads; a readable string is obviously
    // not a message and the note would just be noise.
    const note = document.createElement("div");
    note.className = "wire-note";
    note.textContent = "Binary payload that does not parse as a nested message.";
    wrapper.append(note);
  } else if (field.kind === "group" && depth < 4) {
    const nested = document.createElement("div");
    nested.className = "wire-nested";
    for (const child of field.fields) nested.append(renderWireField(child, depth + 1));
    wrapper.append(nested);
  }
  return wrapper;
}

function describeWireValue(field: WireField): string {
  switch (field.kind) {
    case "varint": {
      const unsigned = field.value.kind === "safe" ? String(field.value.value) : field.value.value.toString();
      return `varint ${unsigned}  (int64 ${field.signed64.toString()}, zigzag ${field.zigzag64.toString()})`;
    }
    case "fixed64":
      return `fixed64 0x${field.raw.toString(16).padStart(16, "0")} (double ${field.asDouble}, int64 ${field.asInt64})`;
    case "fixed32":
      return `fixed32 0x${field.raw.toString(16).padStart(8, "0")} (float ${field.asFloat}, int32 ${field.asInt32})`;
    case "length-delimited": {
      const utf8 = field.utf8 === null ? "not UTF-8" : `"${truncate(field.utf8.replace(/\s+/g, " "), 80)}"`;
      return `len ${field.length} · ${utf8}`;
    }
    case "group":
      return `group with ${field.fields.length} field(s)`;
  }
}

function renderHexTab(bytes: Uint8Array | null, waiting: boolean): void {
  const output = el<HTMLPreElement>("hex-output");
  if (waiting) {
    output.textContent = "Loading payload…";
    return;
  }
  if (bytes === null) {
    output.textContent = "The payload is no longer available.";
    return;
  }
  output.textContent = bytes.byteLength === 0 ? "(empty payload)" : hexDump(bytes);
}

function renderTextTab(frame: FrameMetadata, bytes: Uint8Array | null, waiting: boolean): void {
  const output = el<HTMLPreElement>("text-output");
  if (waiting) {
    output.textContent = "Loading payload…";
    return;
  }
  const payload = state.payloads.get(frame.id);
  if (payload?.text !== null && payload?.text !== undefined) {
    output.textContent = payload.text;
    return;
  }
  if (frame.kind === "binary") {
    output.textContent =
      "This is a binary frame. It is shown as hex rather than lossy text; use the Hex tab.\n\n" +
      (bytes ? hexDump(bytes.subarray(0, 512)) + (bytes.length > 512 ? "\n…" : "") : "");
    return;
  }
  output.textContent = "No text available.";
}

function renderDiagnosticsTab(frame: FrameMetadata, bytes: Uint8Array | null): void {
  const output = el<HTMLDivElement>("diagnostics-output");
  output.replaceChildren();
  const connection = state.connections.get(frame.connectionId)?.connection;
  const rows: Array<[string, string, string?]> = [
    ["Frame id", frame.id],
    ["Connection id", frame.connectionId],
    ["Connection URL", connection?.url ?? "(unknown)"],
    ["Connection state", connection?.state ?? "(unknown)"],
    ["Frame kind", `${frame.kind} (opcode ${frame.opcode})`],
    ["Bytes", String(frame.size)],
    ["Captured at", formatIso(frame.timestamp)],
  ];
  if (frame.monotonicTime !== undefined) rows.push(["CDP timestamp", String(frame.monotonicTime)]);
  if (connection?.handshakeStatus !== undefined) rows.push(["Handshake status", String(connection.handshakeStatus)]);
  if (connection?.protocol) rows.push(["Subprotocol", connection.protocol]);
  if (connection?.extensions) rows.push(["Extensions", connection.extensions]);
  if (connection?.errorMessage) rows.push(["Connection error", connection.errorMessage]);

  if (bytes) {
    const outcome = currentDecode(frame, bytes);
    rows.push(["Decode status", outcome.status]);
    rows.push(["Payload bytes", String(outcome.payloadBytes)]);
    if (outcome.error) rows.push(["Decode error", outcome.error]);
    if (outcome.wire instanceof Error) {
      rows.push(["Wire parse", outcome.wire.message]);
    } else if (outcome.wire) {
      rows.push([
        "Wire parse",
        `${outcome.wire.fields.length} field(s)${outcome.wire.truncated ? `, truncated: ${outcome.wire.truncatedReason ?? "limit reached"}` : ""}`,
      ]);
    }
  } else {
    rows.push(["Payload", "not loaded yet"]);
  }
  if (frame.decodeError) rows.push(["Capture note", frame.decodeError]);

  if (frame.kind === "text") {
    rows.push([
      "Text frame",
      "Decoded from a text frame; protobuf decoding is disabled because CDP already interpreted the bytes.",
    ]);
  }

  for (const [label, value, tone] of rows) {
    const row = document.createElement("div");
    row.className = "diagnostics__row";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("span");
    val.textContent = value;
    if (tone) val.className = tone;
    row.append(key, val);
    output.append(row);
  }
}

/** Colours JSON syntax with spans; never uses innerHTML. */
function highlightJson(value: unknown): Node[] {
  const text = jsonToText(value);
  const nodes: Node[] = [];
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(tokenRe)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(document.createTextNode(text.slice(lastIndex, index)));
    const token = match[0];
    const span = document.createElement("span");
    if (match[1] !== undefined && match[2] !== undefined) {
      const keySpan = document.createElement("span");
      keySpan.className = "json-key";
      keySpan.textContent = match[1];
      span.append(keySpan, document.createTextNode(match[2]));
    } else if (match[1] !== undefined) {
      // Distinguish our tagged lossless wrappers from plain strings.
      span.className = /^"\$(bytes|number|enum)"$/.test(match[1]) ? "json-special" : "json-string";
      span.textContent = token;
    } else if (match[3] !== undefined) {
      span.className = "json-bool";
      span.textContent = token;
    } else {
      span.className = "json-number";
      span.textContent = token;
    }
    nodes.push(span);
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) nodes.push(document.createTextNode(text.slice(lastIndex)));
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Schema dialog                                                       */
/* ------------------------------------------------------------------ */

async function rebuildSchema(): Promise<void> {
  renderSchemaSummary();
  if (state.protoFiles.length === 0) {
    state.schema = null;
    renderSchemaFileList();
    return;
  }
  state.schema = await loadSchema(state.protoFiles);
  renderSchemaSummary();
  renderSchemaFileList();
  renderDetail();
}

function renderSchemaSummary(): void {
  const summary = el<HTMLDivElement>("schema-summary");
  if (state.protoFiles.length === 0) {
    summary.textContent = "No schema loaded";
    return;
  }
  const types = state.schema?.ok ? state.schema.messageTypes.length : 0;
  summary.textContent = state.schema?.ok
    ? `${state.protoFiles.length} file(s), ${types} message type(s)`
    : `${state.protoFiles.length} file(s), schema has errors`;
}

function renderSchemaFileList(): void {
  const list = el<HTMLUListElement>("schema-file-list");
  list.replaceChildren();
  for (const file of state.protoFiles) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "muted";
    size.textContent = `${file.content.length} chars`;
    item.append(name, size);
    list.append(item);
  }
  const errors = el<HTMLDivElement>("schema-errors");
  const problems = state.schema?.errors ?? [];
  const warnings = state.schema?.warnings ?? [];
  if (problems.length === 0 && warnings.length === 0) {
    errors.hidden = true;
    errors.textContent = "";
    return;
  }
  errors.hidden = false;
  errors.textContent = [
    ...problems.map((problem) => `${problem.file || "(schema)"}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`),
    ...warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
}

async function addSchemaFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return;
  const incoming: ProtoFile[] = [];
  const problems: string[] = [];
  for (const file of Array.from(files)) {
    if (file.size > 2 * 1024 * 1024) {
      problems.push(`${file.name}: file is larger than 2 MiB`);
      continue;
    }
    incoming.push({ name: file.name, content: await file.text() });
  }
  const sanitized = sanitizeProtoFiles(incoming);
  problems.push(...sanitized.errors.map((error) => `${error.file || "(schema)"}: ${error.message}`));
  const byName = new Map(state.protoFiles.map((file) => [file.name, file]));
  for (const file of sanitized.files) byName.set(file.name, file);
  state.protoFiles = [...byName.values()];
  await saveSchemaSet(state.protoFiles);
  await rebuildSchema();
  if (problems.length > 0) {
    const errors = el<HTMLDivElement>("schema-errors");
    errors.hidden = false;
    errors.textContent = problems.join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function applySettingsToForm(): void {
  el<HTMLInputElement>("input-retention").value = String(state.settings.retentionLimit);
  el<HTMLInputElement>("input-auto-decode").checked = state.settings.autoDecode;
  el<HTMLInputElement>("input-reuse-schema").checked = state.settings.reusePickedSchema;
  renderRuleRows();
  renderPickedSchemas();
}

/** Renders one editable row per rule, plus a blank row for adding. */
function renderRuleRows(): void {
  const body = el<HTMLTableSectionElement>("rule-rows");
  body.replaceChildren();
  const types = messageTypeOptions(state.schema?.root ?? null);
  state.settings.autoDecodeRules.forEach((rule, index) => {
    body.append(buildRuleRow(rule, types, index));
  });
  const note = el<HTMLSpanElement>("rules-note");
  note.textContent =
    state.settings.autoDecodeRules.length === 0
      ? "No rules yet."
      : `${state.settings.autoDecodeRules.length} rule(s).`;
}

function buildRuleRow(
  rule: AutoDecodeRule,
  types: readonly string[],
  index: number,
): HTMLTableRowElement {
  const row = document.createElement("tr");

  const fieldCell = document.createElement("td");
  const fieldInput = document.createElement("input");
  fieldInput.type = "number";
  fieldInput.min = "1";
  fieldInput.value = String(rule.fieldNumber);
  fieldInput.dataset.ruleField = "fieldNumber";
  fieldCell.append(fieldInput);

  const valueCell = document.createElement("td");
  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.min = "0";
  valueInput.value = String(rule.fieldValue);
  valueInput.dataset.ruleField = "fieldValue";
  valueCell.append(valueInput);

  const typeCell = document.createElement("td");
  const select = document.createElement("select");
  select.dataset.ruleField = "messageType";
  const options = types.includes(rule.messageType) ? types : [rule.messageType, ...types];
  for (const type of options) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    select.append(option);
  }
  select.value = rule.messageType;
  typeCell.append(select);

  const actionCell = document.createElement("td");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn--small";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    // Remove by position. The rendered index matches the rendered row, and the
    // table is rebuilt from state after every change, so indices cannot drift.
    const rows = state.settings.autoDecodeRules.filter((_rule, rowIndex) => rowIndex !== index);
    state.settings = { ...state.settings, autoDecodeRules: rows };
    void saveSettings(state.settings);
    renderRuleRows();
    refreshesAfterRuleChange();
  });
  actionCell.append(remove);

  row.append(fieldCell, valueCell, typeCell, actionCell);
  return row;
}

/** Reads the rule table, dropping rows that are not usable. */
function readRuleRows(): AutoDecodeRule[] {
  const rows = [...document.querySelectorAll<HTMLTableRowElement>("#rule-rows tr")];
  const raw = rows.map((row) => {
    const field = row.querySelector<HTMLInputElement>('[data-rule-field="fieldNumber"]');
    const value = row.querySelector<HTMLInputElement>('[data-rule-field="fieldValue"]');
    const type = row.querySelector<HTMLSelectElement>('[data-rule-field="messageType"]');
    return {
      fieldNumber: Number(field?.value ?? 0),
      fieldValue: Number(value?.value ?? 0),
      messageType: type?.value ?? "",
    };
  });
  return validateRules(raw);
}

/** Rules change every decode, so the table and detail pane are rebuilt. */
function refreshesAfterRuleChange(): void {
  state.outcomes.clear();
  suspendStreaming();
  renderMessages();
  renderDetail();
}

/** Writes the rule list to a file so a working configuration can be kept. */
function exportRules(): void {
  const rules = readRuleRows();
  const document_ = {
    format: "proto-inspector-rules",
    version: 1,
    exportedAt: new Date().toISOString(),
    rules,
  };
  const blob = new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `proto-inspector-rules-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  el<HTMLSpanElement>("rules-transfer-note").textContent = `${rules.length} rule(s) exported.`;
}

/**
 * Reads a rules file, replaces the table with its contents and saves.
 *
 * A file is untrusted input: it is parsed as JSON and every rule is validated.
 * An entry that does not fit is dropped rather than rejecting the whole file,
 * and the count says what actually survived.
 */
async function importRules(file: File | null): Promise<void> {
  const note = el<HTMLSpanElement>("rules-transfer-note");
  if (!file) return;
  if (file.size > 1024 * 1024) {
    note.textContent = "File is larger than 1 MiB.";
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    note.textContent = "Not a JSON file.";
    return;
  }
  const raw: unknown[] | null =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { rules?: unknown }).rules)
      ? ((parsed as { rules: unknown[] }).rules)
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;
  if (!raw) {
    note.textContent = "No rules array found in the file.";
    return;
  }
  const rules = validateRules(raw);
  if (rules.length === 0) {
    note.textContent = `No usable rules in the file (${raw.length} entr${raw.length === 1 ? "y" : "ies"} rejected).`;
    return;
  }
  state.settings = { ...state.settings, autoDecodeRules: rules };
  await saveSettings(state.settings);
  renderRuleRows();
  refreshesAfterRuleChange();
  const dropped = raw.length - rules.length;
  note.textContent =
    dropped > 0
      ? `Imported ${rules.length} rule(s); ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} ignored.`
      : `Imported ${rules.length} rule(s).`;
}

/**
 * Lists the schemas the user chose, so a decision is visible in Settings and
 * not only as a label on a captured row. These live in memory only.
 */
function renderPickedSchemas(): void {
  const body = el<HTMLTableSectionElement>("picked-rows");
  body.replaceChildren();
  const entries: { scope: string; type: string; shape: string }[] = [];
  for (const [frameId, type] of state.chosenTypes) {
    entries.push({ scope: `message ${frameId}`, type, shape: "—" });
  }
  for (const [shape, type] of state.typeByShape) {
    entries.push({ scope: "wire shape", type, shape });
  }
  for (const entry of entries) {
    const row = document.createElement("tr");
    const scope = document.createElement("td");
    scope.textContent = entry.scope;
    const type = document.createElement("td");
    type.textContent = entry.type;
    const shape = document.createElement("td");
    shape.textContent = entry.shape;
    shape.className = "picked-shape";
    if (entry.shape.length > 24) shape.title = entry.shape;
    row.append(scope, type, shape);
    body.append(row);
  }
  const note = el<HTMLParagraphElement>("picked-note");
  note.textContent =
    entries.length === 0
      ? "Nothing picked yet."
      : `${state.chosenTypes.size} message(s), ${state.typeByShape.size} wire shape(s).`;
}

function readSettingsForm(): Settings {
  const retention = Number(el<HTMLInputElement>("input-retention").value);
  return {
    retentionLimit: Number.isFinite(retention) ? retention : state.settings.retentionLimit,
    autoDecode: el<HTMLInputElement>("input-auto-decode").checked,
    reusePickedSchema: el<HTMLInputElement>("input-reuse-schema").checked,
    autoDecodeRules: readRuleRows(),
    maxNestedDepth: state.settings.maxNestedDepth,
  };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

async function exportJson(): Promise<void> {
  const frames = visibleFrames();
  if (frames.length === 0) {
    showError("There are no messages to export.");
    return;
  }
  const exported: ExportFrame[] = [];
  for (const frame of frames) {
    const payload = await ensurePayload(frame.id);
    if (!payload) continue;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(payload.base64);
    } catch {
      continue;
    }
    const outcome = decodeFrame({
      bytes,
      isTextFrame: frame.kind === "text",
      root: state.schema?.root ?? null,
      messageType: chosenTypeFor(frame),
      rememberedType: rememberedTypeFor(frame),
    });
    exported.push({
      id: frame.id,
      connectionId: frame.connectionId,
      connectionUrl: state.connections.get(frame.connectionId)?.connection.url ?? "",
      direction: frame.direction,
      kind: frame.kind,
      timestamp: formatIso(frame.timestamp),
      size: frame.size,
      opcode: frame.opcode,
      decodeStatus: outcome.status,
      messageType: outcome.messageType,
      decodeError: outcome.error,
      base64: payload.base64,
      text: payload.text,
      decoded: outcome.json,
      wireFields:
        outcome.wire && !(outcome.wire instanceof Error)
          ? outcome.wire.fields.map((field) => ({
              fieldNumber: field.fieldNumber,
              wireType: field.wireType,
              wireTypeName: field.wireTypeName,
            }))
          : null,
    });
  }
  const document_ = buildExportDocument(exported);
  const blob = new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `proto-inspector-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ensurePayload(frameId: string): Promise<FramePayloadResponse | null> {
  const cached = state.payloads.get(frameId);
  if (cached) return Promise.resolve(cached);
  const port = state.port;
  if (!port) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: FramePayloadResponse | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      port.onMessage.removeListener(listener);
      if (value) state.payloads.set(value.id, value);
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), 3000);
    const listener = (message: unknown): void => {
      const response = message as WorkerResponse;
      if (response.type === "frame-payload" && response.id === frameId) finish(response);
    };
    port.onMessage.addListener(listener);
    send({ type: "request-frame", id: frameId });
  });
}

/* ------------------------------------------------------------------ */
/* Static handlers                                                     */
/* ------------------------------------------------------------------ */

function wireStaticHandlers(): void {
  el<HTMLButtonElement>("btn-start").addEventListener("click", () => {
    send({ type: "start-capture", mode: "cdp" });
  });
  el<HTMLButtonElement>("btn-stop").addEventListener("click", () => {
    send({ type: "stop-capture" });
  });
  el<HTMLButtonElement>("btn-pause").addEventListener("click", () => {
    const paused = state.status?.paused ?? false;
    send({ type: "pause-capture", paused: !paused });
  });
  el<HTMLButtonElement>("btn-clear").addEventListener("click", () => {
    send({ type: "clear-capture" });
  });
  el<HTMLButtonElement>("btn-export").addEventListener("click", () => {
    void exportJson();
  });
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".view-tab")) {
    tab.addEventListener("click", () => showView((tab.dataset.view ?? "capture") as PanelView));
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".settings-tab")) {
    tab.addEventListener("click", () =>
      showSettingsView((tab.dataset.settingsView ?? "general") as SettingsView),
    );
  }
  el<HTMLButtonElement>("btn-save-settings").addEventListener("click", () => {
    const next = readSettingsForm();
    state.settings = next;
    send({ type: "set-retention", limit: next.retentionLimit });
    void saveSettings(next).then(() => {
      const saved = el<HTMLSpanElement>("settings-saved");
      saved.textContent = "Saved";
      window.setTimeout(() => {
        saved.textContent = "";
      }, 1500);
      // Envelope and default-type changes alter how every frame decodes, so the
      // whole table has to be rebuilt rather than leaving stale type cells.
      state.outcomes.clear();
      suspendStreaming();
      renderMessages();
      renderDetail();
      el<HTMLSpanElement>("settings-saved").textContent = "Saved";
      window.setTimeout(() => {
        const savedNow = el<HTMLSpanElement>("settings-saved");
        if (savedNow.textContent === "Saved") savedNow.textContent = "";
      }, 1800);
    });
  });

  el<HTMLInputElement>("filter-search").addEventListener("input", (event) => {
    state.filters.search = (event.target as HTMLInputElement).value;
    suspendStreaming();
    renderMessages();
  });
  el<HTMLSelectElement>("filter-connection").addEventListener("change", (event) => {
    state.filters.connectionId = (event.target as HTMLSelectElement).value;
    state.selectedConnectionId = state.filters.connectionId || state.selectedConnectionId;
    suspendStreaming();
    renderConnections();
    renderMessages();
  });
  el<HTMLSelectElement>("filter-direction").addEventListener("change", (event) => {
    state.filters.direction = (event.target as HTMLSelectElement).value;
    suspendStreaming();
    renderMessages();
  });
  el<HTMLSelectElement>("filter-status").addEventListener("change", (event) => {
    state.filters.status = (event.target as HTMLSelectElement).value;
    suspendStreaming();
    renderMessages();
  });

  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => {
      state.activeTab = (tab.dataset.tab ?? "decoded") as PanelState["activeTab"];
      renderDetail();
    });
  }
  el<HTMLSelectElement>("decode-type-select").addEventListener("change", () => {
    applyTypeChoice();
  });
  el<HTMLButtonElement>("btn-decode").addEventListener("click", () => {
    applyTypeChoice();
  });
  el<HTMLInputElement>("wire-nested").addEventListener("change", (event) => {
    state.showNested = (event.target as HTMLInputElement).checked;
    renderDetail();
  });
  el<HTMLButtonElement>("btn-copy").addEventListener("click", () => {
    void copySelected();
  });

  el<HTMLInputElement>("input-reuse-schema").addEventListener("change", (event) => {
    // The option decides what the table can show, so rebuild rather than patch.
    state.settings = {
      ...state.settings,
      reusePickedSchema: (event.target as HTMLInputElement).checked,
    };
    void saveSettings(state.settings);
    if (!state.settings.reusePickedSchema) state.typeByShape.clear();
    state.outcomes.clear();
    suspendStreaming();
    renderMessages();
    renderDetail();
  });

  el<HTMLButtonElement>("btn-rules-export").addEventListener("click", () => {
    exportRules();
  });
  el<HTMLButtonElement>("btn-rules-import").addEventListener("click", () => {
    el<HTMLInputElement>("rules-import-file").click();
  });
  el<HTMLInputElement>("rules-import-file").addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    void importRules(input.files?.[0] ?? null);
    input.value = "";
  });

  el<HTMLButtonElement>("btn-add-rule").addEventListener("click", () => {
    // Append an editable blank row; it is persisted when Save is pressed.
    const types = messageTypeOptions(state.schema?.root ?? null);
    const fallback = types[0];
    if (!fallback) {
      el<HTMLSpanElement>("rules-note").textContent = "Load a schema first.";
      return;
    }
    const body = el<HTMLTableSectionElement>("rule-rows");
    body.append(
      buildRuleRow(
        { fieldNumber: 1, fieldValue: 0, messageType: fallback },
        types,
        body.childElementCount,
      ),
    );
    el<HTMLSpanElement>("rules-note").textContent = "Unsaved rule — press Save settings.";
  });
  el<HTMLInputElement>("schema-files").addEventListener("change", (event) => {
    void addSchemaFiles((event.target as HTMLInputElement).files);
  });
  // Static filters have a fixed list; enable search only where the list is
  // long enough to need it.
  for (const id of ["filter-status", "filter-direction"]) {
    const control = el<HTMLSelectElement>(id);
    attachSearchableSelect(control);
  }

  el<HTMLButtonElement>("btn-schema-add").addEventListener("click", () => {
    el<HTMLInputElement>("schema-files").click();
  });
  el<HTMLButtonElement>("btn-schema-clear").addEventListener("click", () => {
    state.protoFiles = [];
    void saveSchemaSet([]).then(() => rebuildSchema());
  });

  // Deliberately no "panel closed" message: the port's disconnect event in the
  // worker is the reliable signal, and it also covers a crashed panel.
}

/**
 * Records the type picked in the dropdown.
 *
 * The choice applies to this frame and to every other captured frame with the
 * same wire shape, because that structure is what determines which types can
 * decode it. Frames whose shape differs keep their own resolution, so a
 * different kind of message is never relabelled by mistake.
 */
function applyTypeChoice(): void {
  const frame = selectedFrame();
  if (!frame) return;
  const chosen = el<HTMLSelectElement>("decode-type-select").value;
  if (chosen) state.chosenTypes.set(frame.id, chosen);
  else state.chosenTypes.delete(frame.id);

  const shape = shapeOf(frame);
  if (shape) {
    if (chosen && state.settings.reusePickedSchema) state.typeByShape.set(shape, chosen);
    else state.typeByShape.delete(shape);
  }
  state.forcedDecodes.add(frame.id);

  // Every decode that depended on the old choice is now stale.
  state.outcomes.clear();
  suspendStreaming();
  renderMessages();
  renderPickedSchemas();
  renderDecodedTabOnly();
}

function renderDecodedTabOnly(): void {
  state.activeTab = "decoded";
  renderDetail();
}

async function copySelected(): Promise<void> {
  const frame = selectedFrame();
  if (!frame) return;
  const payload = state.payloads.get(frame.id);
  const outcome = payload ? currentDecode(frame, base64ToBytes(payload.base64)) : null;
  let text: string;
  switch (state.activeTab) {
    case "hex":
      text = payload ? hexDump(base64ToBytes(payload.base64)) : "";
      break;
    case "wire":
    case "diagnostics":
      text = el<HTMLElement>(
        state.activeTab === "wire" ? "wire-output" : "diagnostics-output",
      ).innerText;
      break;
    case "text":
      text = el<HTMLElement>("text-output").innerText;
      break;
    default:
      text = outcome?.json ? jsonToText(outcome.json) : el<HTMLElement>("decoded-output").innerText;
      break;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showError("Could not copy to the clipboard.");
  }
}

/* ------------------------------------------------------------------ */

void bootstrap();
