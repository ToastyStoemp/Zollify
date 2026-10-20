import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Settings } from './shared.js';

/** Settings and the session's refresh token, one JSON file in the app's user data folder. */
export interface Stored extends Settings {
  /** Refresh token, base64 of safeStorage's ciphertext when available. */
  refreshToken?: string;
  refreshEncrypted?: boolean;
}

export const DEFAULTS: Stored = { server: '', photocraft: '', deviceId: '', links: {}, addToStock: true, theme: 'system', global: null, target: 0, sizeTargets: {}, itemTargets: {}, units: 'cm' };

export class Store {
  data: Stored;
  constructor(readonly file: string) {
    let data: Partial<Stored> = {};
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>;
    } catch {
      /* first run */
    }
    this.data = { ...DEFAULTS, ...data };
    if (!this.data.deviceId) {
      this.data.deviceId = `print-desk-${randomUUID()}`;
      this.save();
    }
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  settings(): Settings {
    const { refreshToken: _r, refreshEncrypted: _e, ...rest } = this.data;
    return rest;
  }
}
