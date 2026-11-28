import { computed } from 'vue';
import { tillEventCheck } from '@zollify/shared';
import { sdk } from '../runtime';
import type { Toast } from './useToast';

/**
 * The event the till sells at, whether it may sell there (ended, Sell 🔒),
 * and the ways out the banners offer: sell at today's event, at the event
 * that took the leftovers, or force sales open.
 */
export function useTillEvent(toast: Toast) {
  const activeEvent = computed(() => sdk().data.events.active());
  /** The till still on a convention that already ended: sales would land in its books, currency and VAT. */
  const tillCheck = computed(() => tillEventCheck(activeEvent.value, sdk().data.events.list()));
  /** Sell 🔒: an open event took over this one's leftovers, so ringing up here would sell from its box. */
  const sellLock = computed(() => (activeEvent.value ? sdk().data.events.sellLock(activeEvent.value.id) : null));
  const sellBlocked = computed(() => !!sellLock.value && !sellLock.value.forced);
  const lockedBy = computed(() => sellLock.value?.by.map((e) => e.name).join(', ') ?? '');
  /** The one event that took the leftovers, when this user may sell there (a helper may not see it). */
  const takerToSell = computed(() => {
    const by = sellLock.value?.by ?? [];
    if (by.length !== 1) return null;
    return sdk().data.events.list().some((e) => e.id === by[0]!.id) ? by[0]! : null;
  });
  async function switchTo(id: string): Promise<void> {
    try {
      await sdk().data.events.setActive(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }
  async function sellAtTaker(): Promise<void> {
    if (takerToSell.value) await switchTo(takerToSell.value.id);
  }
  async function forceSell(on: boolean): Promise<void> {
    const e = activeEvent.value;
    if (!e) return;
    try {
      await sdk().data.events.forceSell(e.id, on);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }
  async function sellAtToday(): Promise<void> {
    const e = tillCheck.value.runningToday;
    if (e) await switchTo(e.id);
  }
  return { activeEvent, tillCheck, sellLock, sellBlocked, lockedBy, takerToSell, sellAtTaker, forceSell, sellAtToday };
}
