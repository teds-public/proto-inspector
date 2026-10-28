/**
 * Turning a file/folder picker selection into importable `.proto` entries.
 *
 * DOM-free so the path and noise-file rules can be tested directly.
 */

/** Files that share a folder with schemas but are never schemas. */
export function isNoiseFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".meta") ||
    lower.endsWith(".import") ||
    lower.endsWith(".ds_store") ||
    lower.startsWith(".") ||
    lower.endsWith(".js") ||
    lower.endsWith(".json") ||
    lower.endsWith(".txt")
  );
}

/**
 * Import path of a picked file, relative to the folder the user chose.
 *
 * A folder pick reports `proto/realtime/realtime.proto`; imports inside the
 * schema say `realtime/realtime.proto`, so the chosen root is stripped. A plain
 * file pick has no relative path and keeps its bare name.
 */
export function relativeProtoPath(name: string, relativePath: string | undefined): string | null {
  const raw = relativePath && relativePath.length > 0 ? relativePath : name;
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (parts.length > 1) parts.shift();
  return parts.join("/") || null;
}
