import { reactive } from 'vue';
import { AUTO_EVENT_DEFAULTS, cleanAutoEventSettings, localIsoDay, tillEventCheck, type AutoEventSettings } from '@zollify/shared';
import { getAccount } from '../session';
import { getSyncedSetting, setSyncedSetting } from './synced-settings';
import { activeEvent, setActiveEvent, visibleEvents } from './sales-events';

/**
 * Automatic events (Events → Automatic). The server opens events on their
 * first day and closes them the day after their last (server-core
 * auto-events.ts) - devices on or not - and every device pulls that like any
 * other edit. What only a device can do is move its own till: when its event
 * has closed or ended and exactly one event is running today, it switches to
 * that one - only while automatic opening is on. That runs at start-up,
 * every quarter of an hour and whenever the app comes back to the front, for
 * any role.
 */

const KEY = 'events.auto';
const EVERY_MS = 15 * 60_000;

export const autoEventSettings = reactive<AutoEventSettings>({ ...AUTO_EVENT_DEFAULTS });

export async function loadAutoEventSettings(): Promise<AutoEventSettings> {
  Object.assign(autoEventSettings, cleanAutoEventSettings(await getSyncedSetting(KEY)));
  return { ...autoEventSettings };
}

/** Saved for the whole account; the server acts on it at its next hourly check (five past the hour). */
export async function setAutoEventSettings(next: Partial<AutoEventSettings>): Promise<void> {
  Object.assign(autoEventSettings, next);
  await setSyncedSetting(KEY, { ...autoEventSettings });
  await runAutoEvents();
}

let running: Promise<string | null> | null = null;

/** One pass: the event the till moved to, or null. Nothing while opening is switched off. */
export function runAutoEvents(today = localIsoDay()): Promise<string | null> {
  running ??= (async () => {
    if (!getAccount()) return null;
    const settings = await loadAutoEventSettings();
    if (!settings.open) return null;
    const check = tillEventCheck(activeEvent.value, visibleEvents.value, today);
    if (activeEvent.value && !check.ended) return null;
    // Planned counts too: offline, the server's opening may not have arrived yet.
    const runningToday = visibleEvents.value.filter((e) => !e.deletedAt && e.kind !== 'store' && e.status !== 'closed' && !!e.dateStart && e.dateStart <= today && (e.dateEnd || e.dateStart)! >= today);
    if (runningToday.length !== 1) return null;
    await setActiveEvent(runningToday[0]!.id);
    return runningToday[0]!.id;
  })().finally(() => (running = null));
  return running;
}

let timer: ReturnType<typeof setInterval> | undefined;
const onVisible = (): void => {
  if (document.visibilityState === 'visible') void runAutoEvents().catch(() => undefined);
};

/** Starts the checks; calling again is harmless. */
export function startAutoEvents(): void {
  void runAutoEvents().catch((err) => console.error('[zollify] automatic events failed', err));
  if (timer) return;
  timer = setInterval(() => void runAutoEvents().catch(() => undefined), EVERY_MS);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
}

export function stopAutoEvents(): void {
  clearInterval(timer);
  timer = undefined;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
}
