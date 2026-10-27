/**
 * Converts Chrome DevTools Protocol `Network.webSocket*` events into the
 * extension's own model.
 *
 * CDP encodes frame payloads as follows (third_party/blink
 * inspector_network_agent.cc `WebSocketMessageToProtocol`):
 *   - opcode 1 (text):  `payloadData` is the UTF-8 text, decoded with a Latin-1
 *     fallback for invalid sequences, so it is NOT guaranteed to round-trip.
 *   - every other opcode: `payloadData` is standard Base64 of the raw bytes.
 * The conversion below therefore treats opcode 1 as text and Base64-decodes
 * everything else, which is the only documented reading of the field.
 */

import { base64ToBytes } from "../shared/bytes";

export interface CdpWebSocketFrame {
  readonly opcode: number;
  readonly mask: boolean;
  readonly payloadData: string;
}

export interface DecodedFramePayload {
  readonly kind: "text" | "binary";
  readonly bytes: Uint8Array;
  readonly text: string | null;
  /** True when the declared text frame could not be represented exactly. */
  readonly lossy: boolean;
  readonly note?: string;
}

export const OPCODE_CONTINUATION = 0;
export const OPCODE_TEXT = 1;
export const OPCODE_BINARY = 2;
export const OPCODE_CLOSE = 8;
export const OPCODE_PING = 9;
export const OPCODE_PONG = 10;

export function decodeCdpFramePayload(frame: CdpWebSocketFrame): DecodedFramePayload {
  if (frame.opcode === OPCODE_TEXT) {
    return decodeTextFrame(frame.payloadData);
  }
  const bytes = base64ToBytes(frame.payloadData);
  return { kind: "binary", bytes, text: null, lossy: false };
}

/**
 * Text frames arrive already decoded as a JavaScript string.
 *
 * The exact original bytes are only recoverable while the payload really was
 * UTF-8, in which case re-encoding the string reproduces them. When CDP had to
 * fall back to Latin-1 the bytes are gone; that is detected here only as a
 * heuristic (C1 control characters cannot appear in valid UTF-8 text) and is
 * reported rather than silently assumed.
 */
function decodeTextFrame(text: string): DecodedFramePayload {
  const bytes = new TextEncoder().encode(text);
  const mayBeLatin1Fallback = /[\u0080-\u009f]/.test(text);
  return {
    kind: "text",
    bytes,
    text,
    lossy: mayBeLatin1Fallback,
    ...(mayBeLatin1Fallback
      ? {
          note:
            "This text frame contains C1 control characters, so Chrome may have used its Latin-1 fallback. " +
            "The bytes shown are the UTF-8 encoding of the text and may differ from the original wire bytes; " +
            "only binary frames are guaranteed to preserve the exact payload.",
        }
      : {}),
  };
}

export function frameKindLabel(opcode: number): string {
  switch (opcode) {
    case OPCODE_TEXT:
      return "text";
    case OPCODE_BINARY:
      return "binary";
    case OPCODE_CLOSE:
      return "close";
    case OPCODE_PING:
      return "ping";
    case OPCODE_PONG:
      return "pong";
    case OPCODE_CONTINUATION:
      return "continuation";
    default:
      return `opcode ${opcode}`;
  }
}
