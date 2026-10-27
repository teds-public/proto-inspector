/** Message contracts between the DevTools panel and the background worker. */

import type { ConnectionInfo, FrameMetadata } from "./model";

export type CaptureMode = "cdp" | "page-hook";

export type CaptureErrorCode =
  | "attach-failed"
  | "attach-conflict"
  | "restricted"
  | "detached"
  | "tab-gone"
  | "network-enable-failed"
  | "unknown";

export interface CaptureStatus {
  readonly mode: CaptureMode;
  readonly attached: boolean;
  readonly tabId: number | null;
  readonly paused: boolean;
  readonly error: string | null;
  readonly errorCode: CaptureErrorCode | null;
  readonly framesRetained: number;
  readonly framesDropped: number;
  readonly retentionLimit: number;
  readonly pageHookActive: boolean;
}

/** Message the panel sends to the worker. */
export type PanelRequest =
  | { readonly type: "panel-hello"; readonly tabId: number }
  | { readonly type: "start-capture"; readonly mode: CaptureMode }
  | { readonly type: "stop-capture" }
  | { readonly type: "pause-capture"; readonly paused: boolean }
  | { readonly type: "clear-capture" }
  | { readonly type: "set-retention"; readonly limit: number }
  | { readonly type: "request-status" }
  | { readonly type: "request-snapshot" }
  | { readonly type: "request-frame"; readonly id: string };

export interface StatusResponse {
  readonly type: "status";
  readonly status: CaptureStatus;
}

export interface ConnectionRecord {
  readonly connection: ConnectionInfo;
  readonly sent: number;
  readonly received: number;
}

export interface SnapshotResponse {
  readonly type: "snapshot";
  readonly status: CaptureStatus;
  readonly connections: readonly ConnectionRecord[];
  readonly frames: readonly FrameMetadata[];
}

export interface FramePayloadResponse {
  readonly type: "frame-payload";
  readonly id: string;
  /** Standard Base64 of the exact captured bytes; the source of truth. */
  readonly base64: string;
  /** Valid UTF-8 text when the frame is text, otherwise null. */
  readonly text: string | null;
}

export type WorkerResponse =
  | StatusResponse
  | SnapshotResponse
  | FramePayloadResponse
  | { readonly type: "error"; readonly message: string };

/** Events the worker pushes to an attached panel. */
export type WorkerEvent =
  | { readonly type: "connection-added"; readonly record: ConnectionRecord }
  | { readonly type: "connection-updated"; readonly record: ConnectionRecord }
  | { readonly type: "frame-added"; readonly frame: FrameMetadata; readonly payload: FramePayloadResponse }
  | { readonly type: "frames-cleared" }
  | { readonly type: "status-changed"; readonly status: CaptureStatus }
  | { readonly type: "capture-reset" };

export const PORT_NAME = "proto-inspector";

/**
 * Port names carry the inspected tab id: `proto-inspector:<tabId>`.
 * Keeping it in the name lets the worker detect a reused/closed port without a
 * separate handshake round trip.
 */
export function portNameForTab(tabId: number): string {
  return `${PORT_NAME}:${tabId}`;
}

export function tabIdFromPortName(name: string): number | null {
  const match = /^proto-inspector:(\d+)$/.exec(name);
  return match?.[1] ? Number(match[1]) : null;
}
