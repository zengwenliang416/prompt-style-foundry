import { defineStore } from 'pinia';

import type { RunMode } from '@onepic/contracts';

/**
 * Run-mode and generation settings (U08).
 *
 * Isolation guarantees (acceptance: 模式切换无隐式上传/密钥迁移):
 * - the BYOK key lives ONLY under its dedicated storage key below; it is
 *   never part of the persisted settings record, never exported, and never
 *   sent anywhere — switching modes performs no network calls and leaves the
 *   key untouched;
 * - managed-generation is surfaced honestly as unavailable until the
 *   server-side identity/allowlist exists (ADR 0001 D-4);
 * - quality/size choices derive from the capability registry in
 *   @onepic/contracts, never from hardcoded guesses.
 */

export const SETTINGS_KEY = 'onepic.settings.v1';
export const BYOK_KEY_STORAGE = 'onepic.byok.key.v1';

export interface PersistedSettings {
  schemaVersion: 1;
  runMode: RunMode;
  byokEndpoint: string;
  byokModel: string;
  byokQuality: string;
}

export interface SettingsState {
  runMode: RunMode;
  byokEndpoint: string;
  byokModel: string;
  byokQuality: string;
  /** Whether a key exists locally; the key value is never kept here. */
  hasApiKey: boolean;
  persistence: 'available' | 'unavailable';
}

const DEFAULTS: PersistedSettings = {
  schemaVersion: 1,
  runMode: 'catalog-only',
  byokEndpoint: '',
  byokModel: '',
  byokQuality: '',
};

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }
    void localStorage.length;
    return localStorage;
  } catch {
    return undefined;
  }
}

function readJson(key: string): unknown {
  const store = storage();
  if (store === undefined) {
    return undefined;
  }
  try {
    const raw = store.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): boolean {
  const store = storage();
  if (store === undefined) {
    return false;
  }
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    runMode: DEFAULTS.runMode,
    byokEndpoint: '',
    byokModel: '',
    byokQuality: '',
    hasApiKey: false,
    persistence: 'available',
  }),

  actions: {
    load(): void {
      const parsed = readJson(SETTINGS_KEY) as Partial<PersistedSettings> | undefined;
      if (
        parsed !== undefined &&
        typeof parsed === 'object' &&
        parsed.schemaVersion === 1 &&
        typeof parsed.runMode === 'string' &&
        ['catalog-only', 'direct-byok', 'managed-generation'].includes(parsed.runMode)
      ) {
        this.runMode = parsed.runMode as RunMode;
        this.byokEndpoint = typeof parsed.byokEndpoint === 'string' ? parsed.byokEndpoint : '';
        this.byokModel = typeof parsed.byokModel === 'string' ? parsed.byokModel : '';
        this.byokQuality = typeof parsed.byokQuality === 'string' ? parsed.byokQuality : '';
      }
      this.hasApiKey = readJson(BYOK_KEY_STORAGE) !== undefined;
    },

    persist(): void {
      const record: PersistedSettings = {
        schemaVersion: 1,
        runMode: this.runMode,
        byokEndpoint: this.byokEndpoint,
        byokModel: this.byokModel,
        byokQuality: this.byokQuality,
      };
      const ok = writeJson(SETTINGS_KEY, record);
      this.persistence = ok ? 'available' : 'unavailable';
    },

    /**
     * Switching modes updates local state only: no network request, no key
     * migration, no image upload. The BYOK key (if any) stays exactly where
     * it is, under its dedicated storage key.
     */
    setRunMode(mode: RunMode): void {
      this.runMode = mode;
      this.persist();
    },

    setByokConfig(endpoint: string, model: string, quality: string): void {
      this.byokEndpoint = endpoint.trim();
      this.byokModel = model;
      this.byokQuality = quality;
      this.persist();
    },

    /** Saves the key to its dedicated storage slot; value never kept in state. */
    saveApiKey(key: string): void {
      const trimmed = key.trim();
      const ok = writeJson(BYOK_KEY_STORAGE, trimmed === '' ? null : trimmed);
      this.hasApiKey = trimmed !== '' && ok;
      this.persistence = ok ? 'available' : 'unavailable';
    },

    clearApiKey(): void {
      const store = storage();
      try {
        store?.removeItem(BYOK_KEY_STORAGE);
      } catch {
        // Storage unavailable: nothing to remove.
      }
      this.hasApiKey = false;
    },
  },
});
