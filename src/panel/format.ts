/** Presentation helpers shared by the panel and the export path. */

import type { FrameMetadata } from "../shared/model";
import type { JsonValue } from "../protobuf/json-value";

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function shortConnectionId(id: string): string {
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Renders a JSON value with syntax spans built from DOM nodes, never HTML. */
export function jsonToText(value: unknown, indent = 2): string {
  return stringifyJson(value, indent);
}

function stringifyJson(value: unknown, indent: number): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): string => {
    const pad = " ".repeat(indent * depth);
    const padIn = " ".repeat(indent * (depth + 1));
    if (node === null) return "null";
    if (typeof node === "string") return JSON.stringify(node);
    if (typeof node === "number") return Number.isFinite(node) ? String(node) : JSON.stringify(String(node));
    if (typeof node === "boolean") return node ? "true" : "false";
    if (typeof node === "bigint") return JSON.stringify(node.toString());
    if (Array.isArray(node)) {
      if (node.length === 0) return "[]";
      const items = node.map((item) => `${padIn}${walk(item, depth + 1)}`);
      return `[\n${items.join(",\n")}\n${pad}]`;
    }
    if (typeof node === "object") {
      if (seen.has(node as object)) return '"[circular]"';
      seen.add(node as object);
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0) return "{}";
      const items = entries.map(([key, entry]) => `${padIn}${JSON.stringify(key)}: ${walk(entry, depth + 1)}`);
      return `{\n${items.join(",\n")}\n${pad}}`;
    }
    return JSON.stringify(String(node));
  };
  return walk(value, 0);
}

/** Status label plus a tone used for the badge colour. */
export function statusBadge(status: FrameMetadata["decodeStatus"]): { label: string; tone: "ok" | "warn" | "error" | "muted" } {
  switch (status) {
    case "decoded":
      return { label: "decoded", tone: "ok" };
    case "not-attempted":
      return { label: "raw", tone: "muted" };
    case "payload-empty":
      return { label: "empty", tone: "muted" };
    case "skipped-text":
      return { label: "text", tone: "muted" };
    case "wire-error":
      return { label: "wire error", tone: "error" };
    case "schema-error":
      return { label: "decode error", tone: "error" };
  }
}

export interface ExportFrame {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionUrl: string;
  readonly direction: string;
  readonly kind: string;
  readonly timestamp: string;
  readonly size: number;
  readonly opcode: number;
  readonly decodeStatus: string;
  readonly messageType: string | null;
  readonly decodeError: string | null;
  /** Base64 of the exact captured bytes. */
  readonly base64: string;
  readonly text: string | null;
  readonly decoded: JsonValue | null;
  /** Top-level wire fields when the payload parsed as protobuf. */
  readonly wireFields: readonly { fieldNumber: number; wireType: number; wireTypeName: string }[] | null;
}

export interface ExportDocument {
  readonly format: "proto-inspector-export";
  readonly version: 1;
  readonly exportedAt: string;
  readonly note: string;
  readonly frames: readonly ExportFrame[];
}

export function buildExportDocument(
  frames: readonly ExportFrame[],
  now: number = Date.now(),
): ExportDocument {
  return {
    format: "proto-inspector-export",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    note: "Payloads are Base64 of the exact captured bytes. This file may contain sensitive application data.",
    frames,
  };
}
