<script setup lang="ts">
import { ref } from 'vue';
import { cart, checkout, clear, isEmpty, itemCount, removeLine, setQty, total } from '../cart';

const providerId = ref('manual');
const message = ref<string | null>(null);
const failed = ref(false);

function newSaleId(): string {
  return crypto.randomUUID();
}

async function take(): Promise<void> {
  message.value = null;
  const outcome = await checkout(providerId.value, newSaleId());
  failed.value = !outcome.approved;
  message.value = outcome.approved
    ? `Approved — ${outcome.sale?.currency} ${outcome.sale?.total.toFixed(2)}`
    : (outcome.error ?? 'The payment did not complete.');
}
</script>

<template>
  <section class="pos">
    <header>
      <h1>Sell</h1>
      <p class="count">{{ itemCount }} item{{ itemCount === 1 ? '' : 's' }}</p>
    </header>

    <p v-if="isEmpty" class="empty">Scan or pick a product to start a sale.</p>

    <ul v-else class="lines">
      <li v-for="line in cart.lines" :key="line.lineId">
        <span class="name">{{ line.name }}</span>
        <input
          class="qty"
          type="number"
          min="1"
          :value="line.qty"
          :aria-label="`Quantity for ${line.name}`"
          @input="setQty(line.lineId, Number(($event.target as HTMLInputElement).value))"
        />
        <span class="price">{{ (line.unitPrice * line.qty).toFixed(2) }}</span>
        <button type="button" :aria-label="`Remove ${line.name}`" @click="removeLine(line.lineId)">
          Remove
        </button>
      </li>
    </ul>

    <footer class="checkout">
      <p class="total"><span>Total</span> <strong>{{ cart.currency }} {{ total.toFixed(2) }}</strong></p>
      <div class="actions">
        <button type="button" :disabled="isEmpty || cart.busy" @click="clear">Clear</button>
        <button type="button" :disabled="isEmpty || cart.busy" @click="take">
          {{ cart.busy ? 'Taking payment…' : 'Take payment' }}
        </button>
      </div>
      <p v-if="message" :class="['result', { bad: failed }]" role="status">{{ message }}</p>
    </footer>
  </section>
</template>

<style scoped>
.pos { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: baseline; justify-content: space-between; }
h1 { font-size: 1.25rem; margin: 0; }
.count, .empty { color: var(--bly-muted, #5a6472); margin: 0; }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.lines li { display: grid; grid-template-columns: 1fr 5rem 6rem auto; gap: .75rem; align-items: center; }
.qty { width: 100%; }
.price { text-align: right; font-variant-numeric: tabular-nums; }
.checkout { display: flex; flex-direction: column; gap: .75rem; border-top: 1px solid var(--bly-line, #d6dde4); padding-top: 1rem; }
.total { display: flex; justify-content: space-between; margin: 0; font-size: 1.125rem; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: .75rem; justify-content: flex-end; }
.result { margin: 0; color: var(--bly-success, #0e7c66); }
.result.bad { color: var(--bly-danger, #c6512f); }
</style>
