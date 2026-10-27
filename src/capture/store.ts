/**
 * Bounded, in-memory capture store.
 *
 * Frames are held newest-last and evicted from the front once the retention
 * limit is reached, so memory stays bounded no matter how fast frames arrive.
 * Nothing here touches chrome.storage: capture data is never persisted.
 */

import type { CapturedFrame, ConnectionInfo, FrameMetadata } from "../shared/model";
import type { ConnectionRecord } from "../shared/protocol";

export const DEFAULT_RETENTION = 5000;
export const MIN_RETENTION = 100;
export const MAX_RETENTION = 50_000;

export interface FrameStorage {
  readonly metadata: FrameMetadata;
  /** Full payload kept separately so the metadata list stays cheap to copy. */
  readonly bytes: Uint8Array;
  readonly text: string | null;
}

export function clampRetention(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETENTION;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, Math.round(value)));
}

export class CaptureStore {
  #connections = new Map<string, ConnectionInfo>();
  #counters = new Map<string, { sent: number; received: number }>();
  #frames: FrameStorage[] = [];
  #retention = DEFAULT_RETENTION;
  #dropped = 0;

  get retention(): number {
    return this.#retention;
  }

  setRetention(limit: number): void {
    this.#retention = clampRetention(limit);
    this.#evict();
  }

  get droppedFrames(): number {
    return this.#dropped;
  }

  get frameCount(): number {
    return this.#frames.length;
  }

  upsertConnection(connection: ConnectionInfo): ConnectionRecord {
    const existing = this.#connections.get(connection.id);
    // Never downgrade a terminal state back to "open" if events arrive late.
    const merged: ConnectionInfo =
      existing && existing.state === "closed" && connection.state !== "closed"
        ? existing
        : { ...existing, ...connection };
    this.#connections.set(connection.id, merged);
    if (!this.#counters.has(connection.id)) {
      this.#counters.set(connection.id, { sent: 0, received: 0 });
    }
    return this.#record(merged);
  }

  updateConnection(id: string, patch: Partial<ConnectionInfo>): ConnectionRecord | null {
    const existing = this.#connections.get(id);
    if (!existing) return null;
    const merged: ConnectionInfo = { ...existing, ...patch };
    this.#connections.set(id, merged);
    return this.#record(merged);
  }

  getConnection(id: string): ConnectionInfo | undefined {
    return this.#connections.get(id);
  }

  addFrame(frame: CapturedFrame): FrameMetadata {
    const metadata: FrameMetadata = {
      id: frame.id,
      connectionId: frame.connectionId,
      direction: frame.direction,
      kind: frame.kind,
      timestamp: frame.timestamp,
      ...(frame.monotonicTime !== undefined ? { monotonicTime: frame.monotonicTime } : {}),
      size: frame.bytes.byteLength,
      opcode: frame.opcode,
      protobufLike: frame.protobufLike,
      ...(frame.wireSummary ? { wireSummary: frame.wireSummary } : {}),
      decodeStatus: frame.decodeStatus,
      ...(frame.decodeError ? { decodeError: frame.decodeError } : {}),
      ...(frame.messageType ? { messageType: frame.messageType } : {}),
    };
    const counters = this.#counters.get(frame.connectionId) ?? { sent: 0, received: 0 };
    if (frame.direction === "send") counters.sent++;
    else counters.received++;
    this.#counters.set(frame.connectionId, counters);

    this.#frames.push({ metadata, bytes: frame.bytes, text: frame.text });
    this.#evict();
    return metadata;
  }

  /** Replaces the derived decode fields after a re-decode. */
  updateFrameMetadata(id: string, patch: Partial<FrameMetadata>): FrameMetadata | null {
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      const entry = this.#frames[i];
      if (entry && entry.metadata.id === id) {
        const metadata = { ...entry.metadata, ...patch };
        this.#frames[i] = { ...entry, metadata };
        return metadata;
      }
    }
    return null;
  }

  /** Most recent frames first, without copying the whole buffer. */
  listRecentFrames(limit: number): readonly FrameMetadata[] {
    const start = Math.max(0, this.#frames.length - Math.max(0, limit));
    const out: FrameMetadata[] = [];
    for (let i = start; i < this.#frames.length; i++) {
      const entry = this.#frames[i];
      if (entry) out.push(entry.metadata);
    }
    return out;
  }

  hasFrame(id: string): boolean {
    return this.getFrameBytes(id) !== undefined;
  }

  getFrameBytes(id: string): FrameStorage | undefined {
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      const entry = this.#frames[i];
      if (entry && entry.metadata.id === id) return entry;
    }
    return undefined;
  }

  /** Frames in capture order, oldest first. */
  listFrames(): readonly FrameMetadata[] {
    return this.#frames.map((entry) => entry.metadata);
  }

  listConnections(): readonly ConnectionRecord[] {
    return [...this.#connections.values()]
      .sort((a, b) => a.discoveredAt - b.discoveredAt)
      .map((connection) => this.#record(connection));
  }

  clearFrames(): void {
    this.#frames = [];
    this.#dropped = 0;
    for (const id of this.#counters.keys()) this.#counters.set(id, { sent: 0, received: 0 });
  }

  /** Full reset when the inspected tab goes away. */
  reset(): void {
    this.#connections.clear();
    this.#counters.clear();
    this.#frames = [];
    this.#dropped = 0;
  }

  #evict(): void {
    const excess = this.#frames.length - this.#retention;
    if (excess > 0) {
      this.#frames.splice(0, excess);
      this.#dropped += excess;
    }
  }

  #record(connection: ConnectionInfo): ConnectionRecord {
    const counters = this.#counters.get(connection.id) ?? { sent: 0, received: 0 };
    return { connection, sent: counters.sent, received: counters.received };
  }
}
