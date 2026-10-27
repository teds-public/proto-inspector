/**
 * `.proto` schema loading and decoding.
 *
 * protobufjs is used for parsing and reflection only. Its generated decoders
 * are built with `Function()`, which a Manifest V3 extension page's CSP blocks,
 * so messages are decoded here by walking the reflected descriptors with
 * `protobuf.Reader`.
 */

import protobuf from "protobufjs";
import { bytesToJson, doubleToJson, enumToJson, longToJson, type JsonValue } from "./json-value";

export interface ProtoFile {
  /** Path used for import resolution, e.g. "game/messages.proto". */
  readonly name: string;
  readonly content: string;
}

export interface SchemaLoadError {
  readonly file: string;
  readonly message: string;
  readonly line?: number;
}

export interface SchemaLoadResult {
  readonly ok: boolean;
  readonly errors: readonly SchemaLoadError[];
  readonly warnings: readonly string[];
  readonly messageTypes: readonly string[];
  readonly enumTypes: readonly string[];
  readonly files: readonly string[];
  readonly root: protobuf.Root | null;
}

export interface DecodeLimits {
  readonly maxDepth: number;
  readonly maxMessageBytes: number;
  readonly maxFields: number;
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = {
  maxDepth: 64,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFields: 100_000,
};

export class SchemaDecodeError extends Error {
  readonly offset: number | null;

  constructor(message: string, offset: number | null = null) {
    super(offset === null ? message : `${message} at byte ${offset}`);
    this.name = "SchemaDecodeError";
    this.offset = offset;
  }
}

/** Normalizes an import path so "./a/b.proto" and "a/b.proto" resolve alike. */
export function normalizeProtoPath(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

const WELL_KNOWN = new Set([
  "google/protobuf/any.proto",
  "google/protobuf/duration.proto",
  "google/protobuf/timestamp.proto",
  "google/protobuf/empty.proto",
  "google/protobuf/struct.proto",
  "google/protobuf/wrappers.proto",
  "google/protobuf/field_mask.proto",
  "google/protobuf/descriptor.proto",
  "google/protobuf/source_context.proto",
  "google/protobuf/type.proto",
  "google/protobuf/api.proto",
  "google/protobuf/compiler/plugin.proto",
  "google/protobuf/json_enumvalue_options.proto",
]);

function addWellKnownTypes(root: protobuf.Root): void {
  const bundled = protobuf.common as unknown as Record<string, unknown> | undefined;
  if (!bundled) return;
  for (const [name, json] of Object.entries(bundled)) {
    if (name === "get" || !WELL_KNOWN.has(name)) continue;
    const nested = (json as { nested?: unknown }).nested;
    if (nested) root.addJSON(nested as Record<string, never>);
  }
}

interface ParsedFile {
  readonly name: string;
  readonly result: protobuf.IParserResult;
}

/**
 * Loads a set of `.proto` files into a single namespace and returns the
 * message/enum inventory. Import graphs inside the set are resolved from the
 * same set, so order does not matter.
 */
export async function loadSchema(files: readonly ProtoFile[]): Promise<SchemaLoadResult> {
  const errors: SchemaLoadError[] = [];
  const warnings: string[] = [];
  if (files.length === 0) {
    return { ok: false, errors: [{ file: "", message: "No .proto files provided" }], warnings, messageTypes: [], enumTypes: [], files: [], root: null };
  }

  const normalized = new Map<string, ProtoFile>();
  for (const file of files) {
    const name = normalizeProtoPath(file.name);
    if (!name.endsWith(".proto")) {
      errors.push({ file: file.name, message: "Not a .proto file" });
      continue;
    }
    if (normalized.has(name)) {
      errors.push({ file: name, message: "Duplicate file name in upload" });
      continue;
    }
    normalized.set(name, { name, content: file.content });
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings, messageTypes: [], enumTypes: [], files: [...normalized.keys()], root: null };
  }

  const root = new protobuf.Root();
  addWellKnownTypes(root);

  const parsed: ParsedFile[] = [];
  for (const [name, file] of normalized) {
    try {
      const result = protobuf.parse(file.content, root, { keepCase: true, alternateCommentMode: true });
      parsed.push({ name, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lineMatch = /line (\d+)/.exec(message);
      errors.push({ file: name, message, ...(lineMatch?.[1] ? { line: Number(lineMatch[1]) } : {}) });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings, messageTypes: [], enumTypes: [], files: [...normalized.keys()], root: null };
  }

  const imported = new Set<string>();
  for (const entry of parsed) {
    for (const raw of entry.result.imports ?? []) {
      const target = normalizeProtoPath(raw);
      imported.add(target);
      if (!normalized.has(target) && !WELL_KNOWN.has(target)) {
        warnings.push(`${entry.name}: import "${raw}" was not provided; types from it must be defined elsewhere`);
      }
    }
  }

  try {
    root.resolveAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ file: "", message: `Unresolved type: ${message}` });
    return { ok: false, errors, warnings, messageTypes: [], enumTypes: [], files: [...normalized.keys()], root: null };
  }

  const messageTypes: string[] = [];
  const enumTypes: string[] = [];
  const seen = new Set<string>();
  for (const file of parsed) {
    const scope = file.result.package ? root.lookup(file.result.package) : root;
    const start = scope && "nestedArray" in scope ? scope : root;
    walkTypes(start as protobuf.NamespaceBase, messageTypes, enumTypes, seen);
  }
  // Include types contributed by imports even when no file declared them.
  walkTypes(root, messageTypes, enumTypes, seen);

  messageTypes.sort();
  enumTypes.sort();
  return { ok: true, errors, warnings, messageTypes, enumTypes, files: [...normalized.keys()], root };
}

function walkTypes(
  ns: protobuf.NamespaceBase,
  messageTypes: string[],
  enumTypes: string[],
  seen: Set<string>,
): void {
  for (const nested of ns.nestedArray) {
    if (nested instanceof protobuf.Type) {
      const full = nested.fullName.replace(/^\./, "");
      if (!seen.has(full)) {
        seen.add(full);
        messageTypes.push(full);
      }
      walkTypes(nested, messageTypes, enumTypes, seen);
    } else if (nested instanceof protobuf.Enum) {
      const full = nested.fullName.replace(/^\./, "");
      if (!seen.has(full)) {
        seen.add(full);
        enumTypes.push(full);
      }
    } else if (nested instanceof protobuf.Namespace) {
      walkTypes(nested, messageTypes, enumTypes, seen);
    }
  }
}

export interface DecodeResult {
  readonly messageType: string;
  readonly json: Record<string, JsonValue>;
  /** Number of bytes consumed by the top-level message. */
  readonly consumedBytes: number;
  readonly fieldCount: number;
}

/**
 * Decodes a protobuf message using the reflected schema.
 * The whole payload must be consumed; trailing bytes are reported as an error
 * rather than silently ignored.
 */
export function decodeWithSchema(
  root: protobuf.Root,
  messageTypeName: string,
  bytes: Uint8Array,
  limits: DecodeLimits = DEFAULT_DECODE_LIMITS,
): DecodeResult {
  if (bytes.length > limits.maxMessageBytes) {
    throw new SchemaDecodeError(
      `Payload of ${bytes.length} bytes exceeds limit of ${limits.maxMessageBytes}`,
    );
  }
  const type = root.lookupType(messageTypeName);
  const json: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const state = { fieldCount: 0 };
  // readFields consumes the whole buffer or throws, so any leftover content
  // (including a zero tag) fails inside the loop.
  let consumed: number;
  try {
    consumed = readFields(bytes, type, json, limits, 0, state);
  } catch (error) {
    // protobufjs throws bare RangeErrors for truncated reads; normalise them so
    // every failure from this module is a SchemaDecodeError.
    if (error instanceof SchemaDecodeError) throw error;
    throw new SchemaDecodeError(error instanceof Error ? error.message : String(error));
  }
  return { messageType: type.fullName.replace(/^\./, ""), json, consumedBytes: consumed, fieldCount: state.fieldCount };
}

interface DecodeState {
  fieldCount: number;
}

/**
 * Reads a complete message from `bytes` and returns the number of bytes read.
 * Nested messages are plain subarrays, so no offsets need rebasing.
 */
function readFields(
  bytes: Uint8Array,
  type: protobuf.Type,
  out: Record<string, JsonValue>,
  limits: DecodeLimits,
  depth: number,
  state: DecodeState,
): number {
  if (depth > limits.maxDepth) {
    throw new SchemaDecodeError(`Message nesting deeper than ${limits.maxDepth} levels`);
  }
  const reader = protobuf.Reader.create(bytes);
  while (reader.pos < bytes.length) {
    const start = reader.pos;
    const tag = reader.uint32();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNumber === 0) throw new SchemaDecodeError("Invalid field number 0", start);
    state.fieldCount++;
    if (state.fieldCount > limits.maxFields) {
      throw new SchemaDecodeError(`Field count exceeds limit of ${limits.maxFields}`, start);
    }
    const field = type.fieldsById[fieldNumber];
    if (!field) {
      // Unknown fields are skipped, matching normal protobuf semantics.
      reader.skipType(wireType);
      continue;
    }
    readField(reader, field, wireType, out, limits, depth, state);
  }
  return reader.pos;
}

function readField(
  reader: protobuf.Reader,
  field: protobuf.Field,
  wireType: number,
  out: Record<string, JsonValue>,
  limits: DecodeLimits,
  depth: number,
  state: DecodeState,
): void {
  const name = field.name;
  if (field.map) {
    readMapEntry(reader, field, wireType, out, limits, depth, state);
    return;
  }
  if (field.repeated && wireType === 2 && isPackable(field)) {
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) throw new SchemaDecodeError("Packed field length exceeds payload", reader.pos);
    const packed = reader.buf.subarray(reader.pos, end);
    reader.pos = end;
    const list = ensureArray(out, name);
    const packedReader = protobuf.Reader.create(packed);
    while (packedReader.pos < packed.length) {
      list.push(readScalar(packedReader, field, packedWireType(field.type), limits, depth + 1));
      state.fieldCount++;
      if (state.fieldCount > limits.maxFields) {
        throw new SchemaDecodeError(`Field count exceeds limit of ${limits.maxFields}`, reader.pos);
      }
    }
    return;
  }
  const value = readScalar(reader, field, wireType, limits, depth + 1);
  if (field.repeated) {
    ensureArray(out, name).push(value);
  } else {
    out[name] = value;
  }
}

function ensureArray(out: Record<string, JsonValue>, name: string): JsonValue[] {
  const existing = out[name];
  if (Array.isArray(existing)) return existing as JsonValue[];
  const list: JsonValue[] = [];
  out[name] = list;
  return list;
}

function isPackable(field: protobuf.Field): boolean {
  const t = field.type;
  return (
    t === "double" || t === "float" || t === "int32" || t === "int64" || t === "uint32" || t === "uint64" ||
    t === "sint32" || t === "sint64" || t === "fixed32" || t === "fixed64" || t === "sfixed32" ||
    t === "sfixed64" || t === "bool" || t === "enum"
  );
}

function packedWireType(type: string): number {
  if (type === "double" || type === "fixed64" || type === "sfixed64") return 1;
  if (type === "float" || type === "fixed32" || type === "sfixed32") return 5;
  return 0;
}

function isGroupField(field: protobuf.Field): boolean {
  // `Type.group` is set by the parser for legacy proto2 groups but is missing
  // from protobufjs' public typings.
  const resolved = field.resolvedType;
  return resolved instanceof protobuf.Type && (resolved as unknown as { group?: boolean }).group === true;
}

/**
 * protobufjs returns `Long` values from its 64-bit reader methods; the public
 * typings expose only low/high/unsigned, so rebuild the bigint here.
 */
function longToBigInt(value: protobuf.Long): bigint {
  const low = BigInt(value.low >>> 0);
  const high = value.unsigned ? BigInt(value.high >>> 0) : BigInt(value.high | 0);
  return (high << 32n) | low;
}

/** Reads a `map<...>` field; protobufjs types these as `MapField`. */
function keyTypeOf(field: protobuf.Field): string {
  return field instanceof protobuf.MapField ? field.keyType : "";
}

function readScalar(
  reader: protobuf.Reader,
  field: protobuf.Field,
  wireType: number,
  limits: DecodeLimits,
  depth: number,
): JsonValue {
  const type = field.type;
  if (isGroupField(field)) {
    if (wireType !== 3) {
      throw new SchemaDecodeError(`Field "${field.name}" expected group framing`, reader.pos);
    }
    const nestedType = field.resolvedType as protobuf.Type;
    const nested: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    readGroup(reader, nestedType, field.id, nested, limits, depth);
    return nested;
  }

  if (field.resolvedType instanceof protobuf.Type) {
    if (wireType !== 2) {
      throw new SchemaDecodeError(`Field "${field.name}" expected a length-delimited message`, reader.pos);
    }
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) throw new SchemaDecodeError("Nested message exceeds payload", reader.pos);
    const nested: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    readFields(reader.buf.subarray(reader.pos, end), field.resolvedType, nested, limits, depth, { fieldCount: 0 });
    reader.pos = end;
    return nested;
  }

  if (field.resolvedType instanceof protobuf.Enum) {
    return readEnum(reader, field.resolvedType, wireType);
  }

  switch (type) {
    case "double":
      return doubleToJson(reader.double());
    case "float":
      return doubleToJson(reader.float());
    case "int32":
      return reader.int32();
    case "uint32":
      return reader.uint32();
    case "sint32":
      return reader.sint32();
    case "fixed32":
      return reader.fixed32();
    case "sfixed32":
      return reader.sfixed32();
    case "int64":
      return longToJson(longToBigInt(reader.int64()));
    case "uint64":
      return longToJson(longToBigInt(reader.uint64()));
    case "sint64":
      return longToJson(longToBigInt(reader.sint64()));
    case "fixed64":
      return longToJson(longToBigInt(reader.fixed64()));
    case "sfixed64":
      return longToJson(longToBigInt(reader.sfixed64()));
    case "bool":
      return reader.bool();
    case "string": {
      if (wireType !== 2) throw new SchemaDecodeError(`Field "${field.name}" expected a string`, reader.pos);
      return reader.string();
    }
    case "bytes": {
      if (wireType !== 2) throw new SchemaDecodeError(`Field "${field.name}" expected bytes`, reader.pos);
      const raw = reader.bytes();
      const out = bytesToJson(raw);
      return out;
    }
    default:
      throw new SchemaDecodeError(`Unsupported field type "${type}" for "${field.name}"`, reader.pos);
  }
}

function readEnum(reader: protobuf.Reader, enumType: protobuf.Enum, wireType: number): JsonValue {
  if (wireType !== 0) throw new SchemaDecodeError(`Enum field expected a varint`, reader.pos);
  const value = reader.int32();
  const name = enumType.valuesById[value];
  return enumToJson(name, value);
}

function readGroup(
  reader: protobuf.Reader,
  type: protobuf.Type,
  groupFieldNumber: number,
  out: Record<string, JsonValue>,
  limits: DecodeLimits,
  depth: number,
): void {
  if (depth > limits.maxDepth) throw new SchemaDecodeError(`Nesting deeper than ${limits.maxDepth} levels`, reader.pos);
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const tag = reader.uint32();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 4) {
      if (fieldNumber !== groupFieldNumber) {
        throw new SchemaDecodeError(`Mismatched end-group ${fieldNumber}`, start);
      }
      return;
    }
    const field = type.fieldsById[fieldNumber];
    if (!field) {
      reader.skipType(wireType);
      continue;
    }
    readField(reader, field, wireType, out, limits, depth, { fieldCount: 0 });
  }
  throw new SchemaDecodeError(`Unterminated group for field ${groupFieldNumber}`, reader.pos);
}

function readMapEntry(
  reader: protobuf.Reader,
  field: protobuf.Field,
  wireType: number,
  out: Record<string, JsonValue>,
  limits: DecodeLimits,
  depth: number,
  state: DecodeState,
): void {
  if (wireType !== 2) throw new SchemaDecodeError(`Map field "${field.name}" expected a length-delimited entry`, reader.pos);
  const length = reader.uint32();
  const end = reader.pos + length;
  if (end > reader.len) throw new SchemaDecodeError("Map entry exceeds payload", reader.pos);
  const sub = protobuf.Reader.create(reader.buf.subarray(reader.pos, end));
  let key: JsonValue = defaultScalar(keyTypeOf(field));
  let value: JsonValue = null;
  const valueType = field.type;
  while (sub.pos < sub.len) {
    const tag = sub.uint32();
    const number = tag >>> 3;
    const innerWire = tag & 0x07;
    if (number === 1) {
      key = readMapKey(sub, keyTypeOf(field));
    } else if (number === 2) {
      if (valueType === "enum" && field.resolvedType instanceof protobuf.Enum) {
        value = readEnum(sub, field.resolvedType, innerWire);
      } else if (field.resolvedType instanceof protobuf.Type) {
        if (innerWire !== 2) throw new SchemaDecodeError("Map value message expected length-delimited", sub.pos);
        const vlen = sub.uint32();
        const vend = sub.pos + vlen;
        if (vend > sub.len) throw new SchemaDecodeError("Map value message exceeds entry", sub.pos);
        const nested: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        readFields(sub.buf.subarray(sub.pos, vend), field.resolvedType, nested, limits, depth + 1, { fieldCount: 0 });
        sub.pos = vend;
        value = nested;
      } else {
        value = readScalar(sub, field, innerWire, limits, depth + 1);
      }
    } else {
      sub.skipType(innerWire);
    }
  }
  reader.pos = end;
  state.fieldCount++;

  const isStringKey = keyTypeOf(field) === "string" || keyTypeOf(field) === "bool";
  if (isStringKey) {
    const map = (out[field.name] && !Array.isArray(out[field.name]) ? out[field.name] : {}) as Record<string, JsonValue>;
    out[field.name] = map;
    map[String(key)] = value;
    return;
  }
  const list = ensureArray(out, field.name);
  list.push({ key, value });
}

function readMapKey(reader: protobuf.Reader, keyType: string): JsonValue {
  if (keyType === "int64" || keyType === "uint64" || keyType === "sint64" || keyType === "fixed64" || keyType === "sfixed64") {
    const value =
      keyType === "int64" ? longToBigInt(reader.int64())
      : keyType === "uint64" ? longToBigInt(reader.uint64())
      : keyType === "sint64" ? longToBigInt(reader.sint64())
      : keyType === "fixed64" ? longToBigInt(reader.fixed64())
      : longToBigInt(reader.sfixed64());
    return longToJson(value);
  }
  switch (keyType) {
    case "string":
      return reader.string();
    case "bool":
      return reader.bool();
    case "int32":
      return reader.int32();
    case "uint32":
      return reader.uint32();
    case "sint32":
      return reader.sint32();
    case "fixed32":
      return reader.fixed32();
    case "sfixed32":
      return reader.sfixed32();
    default:
      throw new SchemaDecodeError(`Unsupported map key type "${keyType}"`, reader.pos);
  }
}

function defaultScalar(type: string): JsonValue {
  switch (type) {
    case "string":
      return "";
    case "bool":
      return false;
    case "int64":
    case "uint64":
    case "sint64":
    case "fixed64":
    case "sfixed64":
      return 0;
    default:
      return 0;
  }
}
