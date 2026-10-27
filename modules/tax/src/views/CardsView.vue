<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { api, type CardPayment, type CardRow } from '../api';
import { sdk } from '../runtime';

/**
 * Card payments: which cards the phone's payment notifications come from, and whether each is
 * the business's or someone's own. A personal card's payments are never kept, so marking one
 * personal also clears what it had sent. Staff quick-add payments from the Add an expense screen.
 */
const cards = ref<CardRow[]>([]);
const payments = ref<CardPayment[]>([]);
const error = ref<string | null>(null);
const loaded = ref(false);
const drafts = ref<Record<string, { role: 'business' | 'personal'; label: string }>>({});

async function load(): Promise<void> {
  try {
    const [c, p] = await Promise.all([api.cards(), api.cardPayments()]);
    cards.value = c.cards;
    payments.value = p.payments;
    drafts.value = Object.fromEntries(c.cards.map((x) => [x.last4, { role: x.role ?? 'business', label: x.label }]));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the cards.';
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

async function save(card: CardRow): Promise<void> {
  const d = drafts.value[card.last4];
  if (!d) return;
  if (d.role === 'personal' && !(await sdk().ui.confirm(`Payments on the card ending ${card.last4} stop being kept, and the ones already here are removed. Payments already added as expenses stay.`, 'Mark this card personal?', { confirm: 'Mark personal' }))) return;
  try {
    await api.markCard(card.last4, d.role, d.label.trim());
    sdk().ui.toast('Card saved.', { kind: 'success' });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the card.';
  }
}
async function dismiss(p: CardPayment): Promise<void> {
  try {
    await api.dismissCardPayment(p.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not remove that payment.';
  }
}
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <section class="cards">
    <header class="top">
      <h1>Card payments</h1>
      <p class="lede">Payments the phone sees on your cards. Mark each card as the business's or personal: personal payments are never kept or shown.</p>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!loaded" class="hint">Loading…</p>

    <article v-if="loaded" class="card">
      <h2>Cards</h2>
      <p v-if="!cards.length" class="hint">No card payments yet. They appear here once the phone has seen one.</p>
      <ul v-else class="rows">
        <li v-for="c in cards" :key="c.last4">
          <span class="who"><strong>•••• {{ c.last4 }}</strong><small>{{ c.role ? (c.role === 'personal' ? 'Personal' : 'Business') : 'Not marked yet' }}</small></span>
          <select v-model="drafts[c.last4]!.role" :aria-label="`Role of the card ending ${c.last4}`">
            <option value="business">Business</option>
            <option value="personal">Personal</option>
          </select>
          <input v-model="drafts[c.last4]!.label" type="text" maxlength="60" placeholder="Name, e.g. Ink Booth Visa" :aria-label="`Name of the card ending ${c.last4}`" />
          <button type="button" class="primary" @click="save(c)">Save</button>
        </li>
      </ul>
    </article>

    <article v-if="loaded" class="card">
      <h2>Recent payments</h2>
      <p v-if="!payments.length" class="hint">Nothing waiting. Payments the phone sees on business cards show here.</p>
      <ul v-else class="rows">
        <li v-for="p in payments" :key="p.id">
          <span class="who"><strong>{{ p.merchant || 'Card payment' }}</strong><small>{{ when(p.at) }}<template v-if="p.last4"> · •••• {{ p.last4 }}</template><template v-if="p.addedExpenseId"> · added to an event</template></small></span>
          <strong>{{ fmtPrice(p.amount, p.currency) }}</strong>
          <button type="button" class="quiet" @click="dismiss(p)">Remove</button>
        </li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.cards { display: flex; flex-direction: column; gap: 1rem; }
.top h1 { margin: 0; font-size: 1.35rem; }
.lede, .hint { margin: 0; font-size: .9rem; color: var(--zfy-muted, #5a6472); max-width: 70ch; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; }
h2 { margin: 0; font-size: 1.05rem; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.rows li { display: grid; grid-template-columns: minmax(7rem, auto) auto 1fr auto; gap: .5rem; align-items: center; font-size: .9rem; }
.rows li:has(> button.quiet) { grid-template-columns: 1fr auto auto; }
.who { display: flex; flex-direction: column; min-width: 0; }
.who small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) { .rows li { grid-template-columns: 1fr auto; } .rows li > input { grid-column: 1 / -1; } }
</style>
