<script setup lang="ts">
import type { SalesEvent, tillEventCheck } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import { Icon } from '@zollify/ui';
import type { ToastKind } from '../composables/useToast';
import { dismissLateApproval, lateApprovalText, lateApprovals } from '../lib/late-approvals';

/**
 * What the till has to say above the products: that it may not sell here
 * (Sell 🔒, or an event that ended), a card that was charged after the seller
 * gave up on it, the notice line, and the sale that just went through.
 */
type SellLock = ReturnType<Sdk['data']['events']['sellLock']>;
defineProps<{
  event: SalesEvent | null;
  sellLock: SellLock;
  /** Names of the events that took this one's leftovers. */
  lockedBy: string;
  /** The one event that took the leftovers, when this user may sell there. */
  takerToSell: { id: string; name: string } | null;
  tillCheck: ReturnType<typeof tillEventCheck>;
  notice: { text: string; kind: ToastKind } | null;
  lastSale: { id: string; total: number; currency: string; units: number } | null;
}>();
const emit = defineEmits<{ sellAtTaker: []; forceSell: [on: boolean]; sellAtToday: []; receipt: []; undo: []; dismissLastSale: [] }>();

const fmtDay = (iso: string | null): string => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
</script>

<template>
  <div v-if="sellLock && !sellLock.forced" class="stale locked" role="alert">
    <Icon name="lock" :size="16" />
    <span><strong>Sell 🔒 {{ event?.name }}.</strong> {{ lockedBy }} took over what was left here, so sales here would come out of its stock.</span>
    <button v-if="takerToSell" type="button" class="primary" @click="emit('sellAtTaker')">Sell at {{ takerToSell.name }}</button>
    <span v-else-if="sellLock.by.length === 1" class="hint">Ask an admin for access to {{ sellLock.by[0]!.name }}.</span>
    <button v-if="sellLock.canForce" type="button" class="danger" @click="emit('forceSell', true)">Force sales</button>
  </div>
  <div v-else-if="sellLock?.forced" class="stale" role="status">
    <Icon name="alert-triangle" :size="16" />
    <span><strong>Sell 🔒 forced open.</strong> {{ lockedBy }} took this event's leftovers; what you sell here may come out of its stock.</span>
    <button type="button" @click="emit('forceSell', false)">Lock again</button>
  </div>
  <div v-else-if="tillCheck.ended" class="stale" role="alert">
    <Icon name="alert-triangle" :size="16" />
    <span><strong>{{ event?.name }} {{ event?.status === 'closed' ? 'is closed' : `ended ${fmtDay(tillCheck.endedOn)}` }}.</strong> Sales you ring up now still go to it.</span>
    <button v-if="tillCheck.runningToday" type="button" class="primary" @click="emit('sellAtToday')">Sell at {{ tillCheck.runningToday.name }}</button>
    <router-link v-else :to="{ name: 'events' }" class="btn">Pick an event</router-link>
  </div>

  <div v-for="a in lateApprovals" :key="a.id" class="stale locked" role="alert">
    <Icon name="alert-triangle" :size="16" />
    <span><strong>{{ lateApprovalText(a) }}</strong></span>
    <button type="button" class="danger" @click="dismissLateApproval(a.id)">Dealt with</button>
  </div>
  <p v-if="notice" :class="['notice', notice.kind]" role="status">{{ notice.text }}</p>

  <div v-if="lastSale" class="last">
    <Icon name="check" :size="16" />
    <span>{{ fmtPrice(lastSale.total, lastSale.currency) }} · {{ lastSale.units }} item{{ lastSale.units === 1 ? '' : 's' }}</span>
    <span class="spacer"></span>
    <button type="button" class="quiet" @click="emit('receipt')"><Icon name="printer" :size="14" /> Receipt</button>
    <button type="button" class="quiet undo" @click="emit('undo')"><Icon name="undo" :size="14" /> Undo</button>
    <button type="button" class="quiet" aria-label="Dismiss" @click="emit('dismissLastSale')"><Icon name="x" :size="14" /></button>
  </div>
</template>

<style scoped>
.stale { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: .6rem 1rem 0; padding: .6rem .8rem; border-radius: 10px; border: 1px solid var(--zfy-warning, #d99a2b); color: var(--zfy-warning-ink, #8a5a00); font-size: .875rem; }
.stale span { flex: 1; min-width: 12rem; }
.stale .btn { text-decoration: none; font-weight: 600; color: inherit; }
.stale.locked { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
.stale .danger { color: var(--zfy-danger, #c6512f); border-color: currentColor; }
.notice { margin: .5rem 1rem 0; padding: .45rem .75rem; border-radius: 8px; font-size: .85rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.notice.bad { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.last { display: flex; align-items: center; gap: .5rem; padding: .4rem 1rem; font-size: .85rem; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.last .spacer { flex: 1; }
.last button { min-height: 1.8rem; padding: .1rem .5rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.last .undo { color: var(--zfy-warning-ink, #8a5a1e); }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
</style>
