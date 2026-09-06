// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BYOK_KEY_STORAGE, SETTINGS_KEY, useSettingsStore } from './store.js';

describe('settings store (U08)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('defaults to catalog-only mode', () => {
    const settings = useSettingsStore();
    settings.load();
    expect(settings.runMode).toBe('catalog-only');
    expect(settings.hasApiKey).toBe(false);
  });

  it('persists mode and BYOK config but never the API key', () => {
    const settings = useSettingsStore();
    settings.load();
    settings.setRunMode('direct-byok');
    settings.setByokConfig('https://api.example.com/v1', 'gpt-image-2', 'high');
    settings.saveApiKey('sk-secret-value-000');

    expect(settings.hasApiKey).toBe(true);
    const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    expect(savedSettings.runMode).toBe('direct-byok');
    expect(JSON.stringify(savedSettings)).not.toContain('sk-secret-value-000');
    const keyRecord = JSON.parse(localStorage.getItem(BYOK_KEY_STORAGE) ?? 'null');
    expect(keyRecord).toBe('sk-secret-value-000');
  });

  it('switching modes performs no network calls and leaves the key untouched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const settings = useSettingsStore();
    settings.load();
    settings.setRunMode('direct-byok');
    settings.saveApiKey('sk-keep-me');

    settings.setRunMode('catalog-only');
    settings.setRunMode('direct-byok');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(BYOK_KEY_STORAGE) ?? 'null')).toBe('sk-keep-me');
    expect(settings.hasApiKey).toBe(true);
  });

  it('clears the key only from its dedicated slot', () => {
    const settings = useSettingsStore();
    settings.load();
    settings.setRunMode('direct-byok');
    settings.saveApiKey('sk-to-clear');
    settings.clearApiKey();

    expect(localStorage.getItem(BYOK_KEY_STORAGE)).toBeNull();
    expect(settings.hasApiKey).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').runMode).toBe('direct-byok');
  });

  it('restores persisted settings on load and ignores invalid modes', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runMode: 'direct-byok',
        byokEndpoint: 'https://api.example.com/v1',
        byokModel: 'gpt-image-2',
        byokQuality: 'high',
      }),
    );
    const settings = useSettingsStore();
    settings.load();
    expect(settings.runMode).toBe('direct-byok');
    expect(settings.byokEndpoint).toBe('https://api.example.com/v1');

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ schemaVersion: 1, runMode: 'hacked-mode' }),
    );
    setActivePinia(createPinia());
    const second = useSettingsStore();
    second.load();
    expect(second.runMode).toBe('catalog-only');
  });

  it('flags unavailable storage instead of throwing', () => {
    const throwing = {
      get length(): number {
        throw new Error('blocked');
      },
      getItem(): string | null {
        throw new Error('blocked');
      },
      setItem(): void {
        throw new Error('blocked');
      },
      clear(): void {},
      key(): string | null {
        return null;
      },
      removeItem(): void {},
    };
    vi.stubGlobal('localStorage', throwing);
    const settings = useSettingsStore();
    settings.load();
    settings.setRunMode('direct-byok');
    expect(settings.persistence).toBe('unavailable');
  });
});
