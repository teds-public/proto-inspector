/**
 * Raw CDP event payload shapes for the Network websocket domain, plus small
 * type guards. Only the fields this extension consumes are modelled.
 */

export interface CdpWebSocketCreated {
  readonly requestId: string;
  readonly url: string;
  readonly initiator?: { readonly type?: string; readonly url?: string; readonly stack?: unknown };
}

export interface CdpWebSocketHandshakeRequest {
  readonly requestId: string;
  readonly timestamp: number;
  readonly wallTime?: number;
  readonly request?: { readonly headers?: Readonly<Record<string, string>> };
}

export interface CdpWebSocketHandshakeResponse {
  readonly requestId: string;
  readonly timestamp: number;
  readonly response?: {
    readonly status?: number;
    readonly statusText?: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

export interface CdpWebSocketFrameEvent {
  readonly requestId: string;
  readonly timestamp: number;
  readonly response: { readonly opcode: number; readonly mask: boolean; readonly payloadData: string };
}

export interface CdpWebSocketFrameErrorEvent {
  readonly requestId: string;
  readonly timestamp: number;
  readonly errorMessage: string;
}

export interface CdpWebSocketClosedEvent {
  readonly requestId: string;
  readonly timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseWebSocketCreated(params: unknown): CdpWebSocketCreated | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const url = params.url;
  if (typeof requestId !== "string" || typeof url !== "string") return null;
  const initiator = params.initiator;
  const initiatorOut =
    isRecord(initiator)
      ? {
          ...(typeof initiator.type === "string" ? { type: initiator.type } : {}),
          ...(typeof initiator.url === "string" ? { url: initiator.url } : {}),
        }
      : undefined;
  return { requestId, url, ...(initiatorOut ? { initiator: initiatorOut } : {}) };
}

export function parseWebSocketClosed(params: unknown): CdpWebSocketClosedEvent | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const timestamp = params.timestamp;
  if (typeof requestId !== "string" || typeof timestamp !== "number") return null;
  return { requestId, timestamp };
}

export function parseHandshakeRequest(params: unknown): CdpWebSocketHandshakeRequest | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const timestamp = params.timestamp;
  if (typeof requestId !== "string" || typeof timestamp !== "number") return null;
  const request = isRecord(params.request) ? params.request : null;
  const headers = request && isRecord(request.headers) ? stringRecord(request.headers) : undefined;
  return { requestId, timestamp, ...(headers ? { request: { headers } } : {}) };
}

export function parseHandshakeResponse(params: unknown): CdpWebSocketHandshakeResponse | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const timestamp = params.timestamp;
  if (typeof requestId !== "string" || typeof timestamp !== "number") return null;
  const response = isRecord(params.response) ? params.response : null;
  if (!response) return { requestId, timestamp };
  const status = typeof response.status === "number" ? response.status : undefined;
  const statusText = typeof response.statusText === "string" ? response.statusText : undefined;
  const headers = isRecord(response.headers) ? stringRecord(response.headers) : undefined;
  return {
    requestId,
    timestamp,
    response: { ...(status !== undefined ? { status } : {}), ...(statusText !== undefined ? { statusText } : {}), ...(headers ? { headers } : {}) },
  };
}

export function parseFrameEvent(params: unknown): CdpWebSocketFrameEvent | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const timestamp = params.timestamp;
  const response = params.response;
  if (typeof requestId !== "string" || typeof timestamp !== "number" || !isRecord(response)) return null;
  const opcode = response.opcode;
  const payloadData = response.payloadData;
  if (typeof opcode !== "number" || typeof payloadData !== "string") return null;
  return {
    requestId,
    timestamp,
    response: { opcode, mask: response.mask === true, payloadData },
  };
}

export function parseFrameErrorEvent(params: unknown): CdpWebSocketFrameErrorEvent | null {
  if (!isRecord(params)) return null;
  const requestId = params.requestId;
  const timestamp = params.timestamp;
  const errorMessage = params.errorMessage;
  if (typeof requestId !== "string" || typeof timestamp !== "number" || typeof errorMessage !== "string") {
    return null;
  }
  return { requestId, timestamp, errorMessage };
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
