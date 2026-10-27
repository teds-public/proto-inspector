/**
 * User preferences persisted in chrome.storage.local.
 *
 * Everything read back is re-validated: storage is a trust boundary, and an
 * older or hand-edited value must not be able to break the panel.
 */

import { clampRetention, DEFAULT_RETENTION } from "../capture/store";
import { parseEnvelopeConfig, type EnvelopeConfig } from "../protobuf/envelope";

export interface Settings {
  readonly retentionLimit: number;
  readonly envelope: EnvelopeConfig;
  readonly autoDecode: boolean;
  /** Message type used when a frame carries no usable envelope id. */
  readonly defaultMessageType: string | null;
  readonly maxNestedDepth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  retentionLimit: DEFAULT_RETENTION,
  envelope: parseEnvelopeConfig(null),
  autoDecode: true,
  defaultMessageType: null,
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
  const defaultMessageType =
    typeof record.defaultMessageType === "string" && record.defaultMessageType.trim().length > 0
      ? record.defaultMessageType.trim()
      : null;
  return {
    retentionLimit: retention,
    envelope: parseEnvelopeConfig(record.envelope),
    autoDecode: record.autoDecode !== false,
    defaultMessageType,
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
