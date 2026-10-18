import { ref } from 'vue';
import { TaxDeadlineSettingsSchema, defaultTaxDeadlineSettings, type TaxDeadlineSettings } from '@zollify/shared';
import { sdk } from './runtime';

/**
 * The module's state lives on the server (it sends the reminders); the last
 * copy is kept in the module's config so the list and the home calendar
 * still show offline.
 */

export interface DeadlineState {
  settings: TaxDeadlineSettings;
  done: { id: string; doneAt: number }[];
}

const CACHE_KEY = 'state';
const empty = (): DeadlineState => ({ settings: defaultTaxDeadlineSettings(), done: [] });

/** Shared by the page, the home card and the calendar, so a tick shows everywhere at once. */
export const state = ref<DeadlineState | null>(null);
export const offline = ref(false);

function clean(raw: unknown): DeadlineState {
  const r = (raw ?? {}) as Partial<DeadlineState>;
  const settings = TaxDeadlineSettingsSchema.safeParse(r.settings ?? {});
  return { settings: settings.success ? settings.data : defaultTaxDeadlineSettings(), done: Array.isArray(r.done) ? r.done : [] };
}

async function keep(s: DeadlineState): Promise<DeadlineState> {
  state.value = s;
  offline.value = false;
  await sdk().config.set(CACHE_KEY, s).catch(() => undefined);
  return s;
}

let inflight: Promise<DeadlineState> | null = null;

/** Fresh from the server, or the cached copy when it cannot be reached. */
export function loadState(force = false): Promise<DeadlineState> {
  if (state.value && !force) return Promise.resolve(state.value);
  return (inflight ??= (async () => {
    try {
      return await keep(clean(await sdk().http.get('state')));
    } catch (err) {
      const cached = await sdk().config.get(CACHE_KEY).catch(() => undefined);
      if (!cached) throw err;
      state.value = clean(cached);
      offline.value = true;
      return state.value;
    }
  })().finally(() => (inflight = null)));
}

export const loadOrEmpty = async (): Promise<DeadlineState> => loadState().catch(() => empty());

export async function saveSettings(settings: TaxDeadlineSettings): Promise<DeadlineState> {
  return keep(clean(await sdk().http.put('settings', settings)));
}

export async function setDone(id: string, done: boolean): Promise<DeadlineState> {
  return keep(clean(await sdk().http.put(`done/${encodeURIComponent(id)}`, { done })));
}

export const doneSet = (s: DeadlineState | null): Set<string> => new Set((s?.done ?? []).map((d) => d.id));
