/**
 * Persistence of imported `.proto` sources.
 *
 * Only the schema *text* is stored, and it is only ever handed to the protobuf
 * parser. It is never evaluated as JavaScript, injected into the DOM as HTML,
 * or sent anywhere.
 */

import type { ProtoFile } from "../protobuf/schema";

const STORAGE_KEY = "protoInspector.schemas";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface StoredSchemaSet {
  readonly files: readonly ProtoFile[];
  readonly updatedAt: number;
}

export interface StoredFileError {
  readonly file: string;
  readonly message: string;
}

export interface SanitizeResult {
  readonly files: readonly ProtoFile[];
  readonly errors: readonly StoredFileError[];
}

/** Validates an untrusted file list (from storage or a file picker). */
export function sanitizeProtoFiles(raw: unknown): SanitizeResult {
  const errors: StoredFileError[] = [];
  if (!Array.isArray(raw)) {
    return { files: [], errors: [{ file: "", message: "Schema data is not an array" }] };
  }
  if (raw.length > MAX_FILES) {
    return { files: [], errors: [{ file: "", message: `At most ${MAX_FILES} files can be stored` }] };
  }
  const files: ProtoFile[] = [];
  let total = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      errors.push({ file: "", message: "Ignored a malformed schema entry" });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const content = typeof record.content === "string" ? record.content : null;
    if (!name || content === null) {
      errors.push({ file: name ?? "", message: "Schema entry needs a name and content" });
      continue;
    }
    if (!name.endsWith(".proto")) {
      errors.push({ file: name, message: "Only .proto files are accepted" });
      continue;
    }
    const size = new TextEncoder().encode(content).byteLength;
    if (size > MAX_FILE_BYTES) {
      errors.push({ file: name, message: `File exceeds the ${MAX_FILE_BYTES} byte limit` });
      continue;
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      errors.push({ file: name, message: `Schema set exceeds the ${MAX_TOTAL_BYTES} byte limit` });
      break;
    }
    files.push({ name, content });
  }
  return { files, errors };
}

export function mergeProtoFiles(
  existing: readonly ProtoFile[],
  incoming: readonly ProtoFile[],
): ProtoFile[] {
  const byName = new Map<string, ProtoFile>();
  for (const file of existing) byName.set(file.name, file);
  for (const file of incoming) byName.set(file.name, file);
  return [...byName.values()];
}

export async function loadSchemaSet(): Promise<StoredSchemaSet> {
  const area = storageArea();
  if (!area) return { files: [], updatedAt: 0 };
  try {
    const stored = await area.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (typeof value !== "object" || value === null) return { files: [], updatedAt: 0 };
    const record = value as Record<string, unknown>;
    const sanitized = sanitizeProtoFiles(record.files);
    return {
      files: sanitized.files,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  } catch {
    return { files: [], updatedAt: 0 };
  }
}

export async function saveSchemaSet(files: readonly ProtoFile[]): Promise<void> {
  const area = storageArea();
  if (!area) return;
  const sanitized = sanitizeProtoFiles(files);
  await area.set({ [STORAGE_KEY]: { files: sanitized.files, updatedAt: Date.now() } });
}

export async function clearSchemaSet(): Promise<void> {
  const area = storageArea();
  if (!area) return;
  await area.remove(STORAGE_KEY);
}

function storageArea(): chrome.storage.StorageArea | null {
  const available = typeof chrome !== "undefined" && chrome.storage?.local;
  return available ? chrome.storage.local : null;
}
