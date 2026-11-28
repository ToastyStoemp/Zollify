<script setup lang="ts">
import { computed, ref } from 'vue';
import { fmtPrice } from '@zollify/shared';
import type { TillAction } from '@zollify/sdk';
import { Icon } from '@zollify/ui';
import { GIVEN_AWAY, appliedDiscounts, baseTotal, cardInBase, cart, chargeTotals, clear, customDiscountCharged, isConverting, itemCount, setQty, total } from '../cart';
import { useCartLines } from '../composables/useCartLines';
import { useTillMoney } from '../composables/useTillMoney';
import { allocateDiscounts } from '../discounts';
import { saleTaxFor } from '../lib/after-sale';
import { vatRateLabel } from '../receipt';

/**
 * The cart: its lines, the sums, and the buttons that start a discount, a misc
 * item or a payment. A side panel on a wide screen, a full-screen sheet on a
 * phone (`sheet`). It reads the shared cart directly; what its buttons start
 * is the till's.
 */
defineProps<{
  /** Narrow screens: shown as a sheet over the till. */
  sheet: boolean;
  /** Buttons other modules add beside "+ Misc item". */
  actionButtons: TillAction[];
  /** The account's own payment methods, after Cash, Card and Split. */
  customMethods: string[];
  /** Sell 🔒: nothing may be paid for at this event. */
  sellBlocked: boolean;
  /** The cart comes to nothing: one "Give away" button instead of the pay buttons. */
  givesAway: boolean;
}>();
const emit = defineEmits<{ close: []; discount: []; misc: []; action: [action: TillAction]; pay: [method: string] }>();

const { money, onCard } = useTillMoney();
const lines = useCartLines();

/**
 * The VAT inside the total, per rate, when the event charges VAT - so a seller
 * sees in the cart what the receipt will say ("incl. 25% VAT EUR 19.60"), not
 * only afterwards. Nothing when the event is exempt or no rate is known. Same
 * arithmetic as the receipt: each line's charged total less its share of the
 * discounts, VAT = gross × rate / (100 + rate), rounded once per rate.
 */
const cartVat = computed(() => {
  if (!lines.value.length) return [];
  const tax = saleTaxFor(cart.eventId, cart.lines.map((l) => l.productId));
  if (!tax || tax.exempt) return [];
  const asLines = lines.value.map((l) => ({ pid: l.productId, vid: l.variantId, title: l.name, variantLabel: l.variantLabel ?? null, type: l.type, qty: l.qty, unitPrice: l.chargedUnit, lineTotal: l.chargedTotal }));
  const shares = allocateDiscounts(asLines, chargeTotals.value);
  const byRate = new Map<number, number>();
  asLines.forEach((l, i) => {
    const rate = tax.rates[i];
    if (rate == null) return;
    byRate.set(rate, (byRate.get(rate) ?? 0) + Math.round((l.lineTotal - (shares[i] ?? 0)) * 100));
  });
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, grossMinor]) => ({ rate, vat: Math.round((grossMinor * rate) / (100 + rate)) / 100 }));
});

const clearArmed = ref(false);
let clearTimer: ReturnType<typeof setTimeout> | undefined;
function tapClear(): void {
  if (!clearArmed.value) {
    clearArmed.value = true;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (clearArmed.value = false), 3000);
    return;
  }
  clearTimeout(clearTimer);
  clearArmed.value = false;
  clear();
}
</script>

<template>
  <!-- ── Cart ─────────────────────────────────────────────────────────── -->
  <aside :class="['cart', { sheet }]">
    <header>
      <h2>Cart</h2>
      <button v-if="itemCount" type="button" :class="['quiet', 'clear', { armed: clearArmed }]" @click="tapClear">{{ clearArmed ? 'Really clear?' : 'Clear' }}</button>
      <button type="button" class="quiet close" aria-label="Close cart" @click="emit('close')"><Icon name="x" :size="18" /></button>
    </header>

    <div class="lines">
      <p v-if="!lines.length" class="empty">Cart is empty</p>
      <ul v-else>
        <li v-for="l in lines" :key="l.lineId">
          <div class="row"><span class="name">{{ l.name }}</span><strong>{{ money(l.chargedTotal) }}</strong></div>
          <div v-if="l.fixed" class="row qty">
            <span>× {{ l.qty }}</span>
            <small>à {{ money(l.chargedUnit) }}</small>
            <button type="button" class="quiet" :aria-label="`Remove ${l.name}`" @click="setQty(l.lineId, 0)">Remove</button>
          </div>
          <div v-else class="row qty">
            <button type="button" :aria-label="`One fewer ${l.name}`" @click="setQty(l.lineId, l.qty - 1)">−</button>
            <span>{{ l.qty }}</span>
            <button type="button" :aria-label="`One more ${l.name}`" @click="setQty(l.lineId, l.qty + 1)">+</button>
            <small>à {{ money(l.chargedUnit) }}</small>
          </div>
        </li>
      </ul>
    </div>

    <footer>
      <div class="sums">
        <div class="row muted"><span>Subtotal</span><span>{{ money(chargeTotals.subtotal) }}</span></div>
        <div v-for="r in appliedDiscounts" :key="r.rule.id" class="row good"><span>{{ r.rule.name }}</span><span>− {{ money(r.amount) }}</span></div>
        <div v-if="cart.custom" class="row good"><span>{{ cart.custom.name }}</span><span>− {{ money(customDiscountCharged) }}</span></div>
        <div class="row total"><span>Total</span><span>{{ money(total) }}</span></div>
        <div v-for="r in cartVat" :key="r.rate" class="row muted small"><span>incl. {{ vatRateLabel(r.rate) }} VAT</span><span>{{ money(r.vat) }}</span></div>
        <div v-if="isConverting" class="row muted small"><span>{{ cart.baseCurrency }} equivalent</span><span>{{ fmtPrice(baseTotal, cart.baseCurrency) }}</span></div>
        <div v-if="cardInBase" class="row muted small"><span>Card charges</span><span>{{ onCard(total) || 'no rate yet' }}</span></div>
      </div>
      <div class="tools">
        <button type="button" :disabled="!itemCount" @click="emit('discount')">{{ cart.custom ? 'Edit discount' : '+ Discount' }}</button>
        <button type="button" @click="emit('misc')">+ Misc item</button>
        <button v-for="a in actionButtons" :key="a.id" type="button" @click="emit('action', a)">+ {{ a.label }}</button>
      </div>
      <div v-if="givesAway" class="pay">
        <button type="button" class="free" :disabled="sellBlocked" @click="emit('pay', GIVEN_AWAY)">Give away</button>
      </div>
      <div v-else class="pay">
        <button type="button" class="cash" :disabled="!itemCount || sellBlocked" @click="emit('pay', 'cash')">Cash</button>
        <button type="button" class="card" :disabled="!itemCount || sellBlocked" @click="emit('pay', 'card')">Card</button>
        <button type="button" class="split" :disabled="!itemCount || sellBlocked" @click="emit('pay', 'split')">Split</button>
        <button v-for="m in customMethods" :key="m" type="button" class="custom" :disabled="!itemCount || sellBlocked" @click="emit('pay', m)">{{ m }}</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }

.cart { display: flex; flex-direction: column; border-left: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); position: sticky; top: 0; height: calc(100vh - 0px); }
.cart header { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.cart h2 { margin: 0; font-size: 1rem; flex: 1; }
.cart .clear { min-height: 2.2rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.cart .clear.armed { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.cart .close { display: none; }
.lines { flex: 1; min-height: 0; overflow-y: auto; padding: .6rem; }
.lines ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.lines li { background: var(--zfy-bg, #f1f4f6); border-radius: 10px; padding: .55rem .7rem; display: flex; flex-direction: column; gap: .3rem; }
.row { display: flex; justify-content: space-between; align-items: center; gap: .5rem; font-size: .875rem; }
.row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.qty { justify-content: flex-start; gap: .5rem; }
.row.qty button { min-height: 2.2rem; min-width: 2.2rem; padding: 0; font-weight: 700; }
.row.qty span { min-width: 1.5rem; text-align: center; font-variant-numeric: tabular-nums; }
.row.qty small { margin-left: auto; color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.cart footer { border-top: 1px solid var(--zfy-line, #d6dde4); padding: .7rem; display: flex; flex-direction: column; gap: .5rem; }
.sums { display: flex; flex-direction: column; gap: .15rem; font-variant-numeric: tabular-nums; }
.row.total { font-size: 1.05rem; font-weight: 700; }
.row.small { font-size: .78rem; }
.tools { display: flex; gap: .4rem; flex-wrap: wrap; }
.tools button { flex: 1; min-height: 2.2rem; font-size: .8rem; padding: .2rem .4rem; }
.pay { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .4rem; }
.pay .custom { grid-column: 1 / -1; background: var(--zfy-ink, #1a2230); }
.pay button { min-height: 2.8rem; font-weight: 700; color: #fff; border: 0; }
.pay .cash { background: #0e7c66; }
.pay .card { background: #2f6fb8; }
.pay .split { background: #b8742f; }
.pay .free { background: #8a4fb8; }
.pay .free { grid-column: 1 / -1; }
.pay button:hover:not(:disabled) { filter: brightness(1.08); }

@media (max-width: 860px) {
  /* The cart is a sheet over the till here: hidden until the till opens it (the cart bar). */
  .cart { display: none; }
  .cart.sheet { display: flex; position: fixed; inset: 0; z-index: 25; height: auto; border-left: 0; }
  .cart.sheet .close { display: inline-flex; }
  /* As a fixed inset:0 overlay this sits completely outside .content's own
     padding (which already gets the safe-area treatment) - without its own
     copy, "Cart"/"Clear"/the close button rendered straight under the
     status bar, confirmed from a phone screenshot showing them behind the
     clock and battery icons. */
  .cart.sheet header { padding-top: calc(.75rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px))); }
}
</style>
