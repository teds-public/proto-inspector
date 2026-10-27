/** Data model shared across capture, background, storage and the panel. */

export type Direction = "send" | "receive";

/** Frame kind as reported by the transport, before any interpretation. */
export type FrameKind = "text" | "binary";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface ConnectionInfo {
  /** CDP request id, unique per inspected target. */
  readonly id: string;
  readonly url: string;
  readonly state: ConnectionState;
  readonly initiator?: string;
  /** Unix epoch milliseconds, wall clock, when the connection was discovered. */
  readonly discoveredAt: number;
  readonly closedAt?: number;
  readonly errorMessage?: string;
  readonly handshakeStatus?: number;
  readonly protocol?: string;
  readonly extensions?: string;
}

export type DecodeStatus =
  | "decoded"
  | "schema-error"
  | "wire-error"
  | "not-attempted"
  | "payload-empty"
  | "skipped-text";

export interface WireFieldSummary {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly wireTypeName: string;
}

/**
 * A captured frame. `bytes` holds the exact payload; text is only populated
 * when the transport declared a text frame or the bytes decode as valid UTF-8.
 */
export interface CapturedFrame {
  readonly id: string;
  readonly connectionId: string;
  readonly direction: Direction;
  readonly kind: FrameKind;
  /** Epoch milliseconds. */
  readonly timestamp: number;
  /** Milliseconds since the inspected page's time origin, as reported by CDP. */
  readonly monotonicTime?: number;
  readonly bytes: Uint8Array;
  /** Valid UTF-8 text for text frames, otherwise null. Never a lossy decode. */
  readonly text: string | null;
  readonly opcode: number;
  /** True when the payload looked like a protobuf message body. */
  readonly protobufLike: boolean;
  readonly wireSummary?: readonly WireFieldSummary[];
  readonly decodeStatus: DecodeStatus;
  readonly decodeError?: string;
  readonly messageType?: string;
}

/** Frame metadata without the payload, safe to keep for very large captures. */
export interface FrameMetadata {
  readonly id: string;
  readonly connectionId: string;
  readonly direction: Direction;
  readonly kind: FrameKind;
  readonly timestamp: number;
  readonly monotonicTime?: number;
  readonly size: number;
  readonly opcode: number;
  readonly protobufLike: boolean;
  readonly wireSummary?: readonly WireFieldSummary[];
  readonly decodeStatus: DecodeStatus;
  readonly decodeError?: string;
  readonly messageType?: string;
}
