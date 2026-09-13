import { sdk } from '../runtime';

/**
 * Per-module settings, backed by the SDK's own config store. Keeps POS
 * settings inside this module's namespace so they leave with it on uninstall.
 */
export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  return sdk().config.get<T>(key);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  return sdk().config.set(key, value);
}
