/**
 * Opcode-prefixed WebSocket frames.
 *
 * Some protocols put a fixed-width opcode in front of the protobuf body and
 * document the mapping in the schema itself:
 *
 *   enum LobbyRealtimeOpcode {
 *     // opcode: 1002
 *     // request: GetLobbyConfigsRequest
 *     // response: GetLobbyConfigsResponse
 *     LOBBY_GET_LOBBY_CONFIGS = 1002;
 *   }
 *
 * Those comments are read from the parsed root, so the type for a frame comes
 * from the schema the user loaded rather than from a guess.
 */

import protobuf from "protobufjs";
import { parseWireFormat } from "./wire";

export interface OpcodeEntry {
  readonly opcode: number;
  /** Message type for the opcode in a frame the page sent. */
  readonly request: string | null;
  /** Message type for the opcode in a frame the page received. */
  readonly response: string | null;
}

export type OpcodeRegistry = ReadonlyMap<number, OpcodeEntry>;

const OPCODE_RE = /^\s*opcode\s*:\s*(\d+)\s*$/;
const ROLE_RE = /^\s*(request|response)\s*:\s*([^;]*)/;
const NONE = new Set(["none", "null", "n/a", "-", ""]);

interface DeclaredOpcode {
  readonly opcode: number;
  readonly request: string | null;
  readonly response: string | null;
}

function parseComment(comment: string | null | undefined): DeclaredOpcode | null {
  if (!comment) return null;
  let opcode: number | null = null;
  let request: string | null = null;
  let response: string | null = null;
  for (const line of comment.split("\n")) {
    const op = OPCODE_RE.exec(line);
    if (op?.[1]) {
      opcode = Number(op[1]);
      continue;
    }
    const role = ROLE_RE.exec(line);
    if (!role?.[1] || role[2] === undefined) continue;
    const value = role[2].trim();
    const type = NONE.has(value.toLowerCase()) ? null : value;
    if (role[1] === "request") request = type;
    else response = type;
  }
  if (opcode === null || !Number.isSafeInteger(opcode) || opcode < 0) return null;
  return { opcode, request, response };
}

/** Resolves a type name written in a comment relative to the enum's package. */
function resolveTypeName(root: protobuf.Root, pkg: string, name: string): string | null {
  const dotted = name.replace(/^\./, "");
  const packageParts = pkg.length > 0 ? pkg.split(".") : [];
  // Most specific scope first: the enum's package, then each parent package.
  for (let depth = packageParts.length; depth >= 0; depth--) {
    const prefix = packageParts.slice(0, depth).join(".");
    const candidate = prefix.length > 0 ? `${prefix}.${dotted}` : dotted;
    const found = root.lookup(candidate);
    if (found instanceof protobuf.Type) return found.fullName.replace(/^\./, "");
  }
  return null;
}

function packageOf(node: protobuf.ReflectionObject): string {
  const parts: string[] = [];
  let current: protobuf.ReflectionObject | null = node;
  while (current && !(current instanceof protobuf.Root)) {
    if (current instanceof protobuf.Namespace) parts.unshift(current.name);
    current = current.parent;
  }
  return parts.join(".");
}

/**
 * Collects every enum value whose comment declares an `opcode`, across the
 * whole loaded schema. A later declaration of the same opcode does not replace
 * an earlier one: the first wins, so load order stays predictable.
 */
export function readOpcodeRegistry(root: protobuf.Root | null): OpcodeRegistry {
  const registry = new Map<number, OpcodeEntry>();
  if (!root) return registry;
  const visit = (ns: protobuf.NamespaceBase): void => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Enum) {
        const pkg = packageOf(nested);
        for (const [name, comment] of Object.entries(nested.comments ?? {})) {
          const parsed = parseComment(comment);
          if (!parsed || registry.has(parsed.opcode)) continue;
          // Only values the enum declares are trusted, so a stray comment on an
          // unrelated node cannot invent a mapping.
          if (!(name in nested.values)) continue;
          registry.set(parsed.opcode, {
            opcode: parsed.opcode,
            request: parsed.request === null ? null : resolveTypeName(root, pkg, parsed.request),
            response: parsed.response === null ? null : resolveTypeName(root, pkg, parsed.response),
          });
        }
      }
      if (nested instanceof protobuf.Namespace) visit(nested);
    }
  };
  visit(root);
  return registry;
}

/** The schema type for a frame's opcode, chosen by direction. */
export function opcodeTypeFor(
  registry: OpcodeRegistry,
  opcode: number,
  direction: "send" | "receive",
): string | null {
  const entry = registry.get(opcode);
  if (!entry) return null;
  return direction === "send" ? entry.request : entry.response;
}

export type FramePrefixMode = "auto" | "none" | "uint32be";

export interface FramePayload {
  /** Opcode read from the prefix, or null when the frame carries none. */
  readonly opcode: number | null;
  /** The protobuf body: the frame itself, or the frame after the prefix. */
  readonly payload: Uint8Array;
  readonly prefixed: boolean;
}

const PREFIX_BYTES = 4;

function parsesAsMessage(bytes: Uint8Array): boolean {
  try {
    parseWireFormat(bytes, { maxMessageBytes: 16 * 1024 * 1024, maxDepth: 2, maxFields: 64, maxNestedBytes: 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits a frame into opcode and body.
 *
 * `auto` strips the prefix only when all three hold: the leading uint32 is an
 * opcode the loaded schema declares, the raw frame does not parse as protobuf,
 * and the remainder does. A frame that already parses is never reinterpreted.
 */
export function splitFrame(
  bytes: Uint8Array,
  mode: FramePrefixMode,
  registry: OpcodeRegistry,
): FramePayload {
  if (mode === "none" || bytes.byteLength < PREFIX_BYTES) {
    return { opcode: null, payload: bytes, prefixed: false };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = view.getUint32(0, false);
  const rest = bytes.subarray(PREFIX_BYTES);
  if (mode === "uint32be") {
    return { opcode, payload: rest, prefixed: true };
  }
  if (!registry.has(opcode)) return { opcode: null, payload: bytes, prefixed: false };
  if (parsesAsMessage(bytes)) return { opcode: null, payload: bytes, prefixed: false };
  if (rest.byteLength > 0 && !parsesAsMessage(rest)) {
    return { opcode: null, payload: bytes, prefixed: false };
  }
  return { opcode, payload: rest, prefixed: true };
}
