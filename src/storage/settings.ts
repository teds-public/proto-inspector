/**
 * User preferences persisted in chrome.storage.local.
 *
 * Everything read back is re-validated: storage is a trust boundary, and an
 * older or hand-edited value must not be able to break the panel.
 */

import { clampRetention, DEFAULT_RETENTION } from "../capture/store";

export interface Settings {
  readonly retentionLimit: number;
  /** Decode each frame on arrival using the schema chosen for it. */
  readonly autoDecode: boolean;
  /**
   * Reuse the schema picked for one message for every later message with the
   * same wire shape. A decision the user made, never a guess.
   */
  readonly reusePickedSchema: boolean;
  readonly maxNestedDepth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  retentionLimit: DEFAULT_RETENTION,
  autoDecode: true,
  reusePickedSchema: true,
  maxNestedDepth: 16,
};

const STORAGE_KEY = "protoInspector.settings";

export function validateSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const record = raw as Record<string, unknown>;
  const retention =
    typeof record.retentionLimit === "number" ? clampRetention(record.retentionLimit) : DEFAULT_SETTINGS.retentionLimit;
  const depth =
    typeof record.maxNestedDepth === "number" && Number.isInteger(record.maxNestedDepth)
      ? Math.min(64, Math.max(1, record.maxNestedDepth))
      : DEFAULT_SETTINGS.maxNestedDepth;
  return {
    retentionLimit: retention,
    autoDecode: record.autoDecode !== false,
    reusePickedSchema: record.reusePickedSchema !== false,
    maxNestedDepth: depth,
  };
}

function storageArea(): chrome.storage.StorageArea | null {
  const available = typeof chrome !== "undefined" && chrome.storage?.local;
  return available ? chrome.storage.local : null;
}

export async function loadSettings(): Promise<Settings> {
  const area = storageArea();
  if (!area) return DEFAULT_SETTINGS;
  try {
    const stored = await area.get(STORAGE_KEY);
    return validateSettings(stored[STORAGE_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const area = storageArea();
  if (!area) return;
  await area.set({ [STORAGE_KEY]: settings });
}
