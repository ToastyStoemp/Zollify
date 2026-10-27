<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { LOYALTY_MEMBER_LINE_KEY, LOYALTY_MEMBER_REF_KIND, LOYALTY_REWARD_LINE_KEY, LOYALTY_REWARD_REF_KIND, fmtPrice, loyaltyUnit, memberCodeIn, rewardAmount, rewardLabel } from '@zollify/shared';
import { api, errorText, type Lookup } from '../api';
import { sdk } from '../runtime';

/**
 * Over the till: scan or type a customer's card, put the sale on it (a
 * zero-price line naming the member, so the synced sale earns), and use a
 * reward when they have one - a negative line worked out from what is in
 * the cart. Reading a card needs the server; a scanned QR in the till's own
 * search box does the attaching without opening this.
 */
const emit = defineEmits<{ close: [] }>();
const input = ref<HTMLInputElement | null>(null);
const code = ref('');
const found = ref<Lookup | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const itemPrice = ref('');
/** Setting the card to a balance (an old paper card brought over): open when allowed. */
const setting = ref(false);
const setTo = ref('');
const currency = computed(() => sdk().data.events.active()?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'EUR');
const money = (n: number) => fmtPrice(n, currency.value);
const onSale = computed(() => sdk().till.findLine(LOYALTY_MEMBER_LINE_KEY));
const rewardOnSale = computed(() => sdk().till.findLine(LOYALTY_REWARD_LINE_KEY));
/** What the sale comes to now, for pricing the reward; null on an older shell that cannot say. */
const cartTotal = computed(() => sdk().till.total?.()?.total ?? null);
const settings = computed(() => found.value?.settings ?? null);
const standing = computed(() => found.value?.member.standing ?? null);
const unit = (n: number) => (settings.value ? loyaltyUnit(settings.value, n) : 'stamps');
const needsPrice = computed(() => settings.value?.reward.kind === 'item');
const rewardValue = computed(() => {
  if (!settings.value) return 0;
  // The reward comes off what is in the cart before it: with one in already, the rest of the cart.
  const base = (cartTotal.value ?? 0) + Math.abs(rewardOnSale.value?.unitPrice ?? 0);
  return rewardAmount(settings.value, base, Number(String(itemPrice.value).replace(',', '.')) || 0);
});

onMounted(async () => {
  await nextTick();
  input.value?.focus();
});

async function look(): Promise<void> {
  const c = memberCodeIn(code.value);
  if (!c) return void (error.value = 'That is not a card code - it reads LY-… on the card.');
  busy.value = true;
  error.value = null;
  try {
    found.value = await api.lookup(c);
  } catch (err) {
    found.value = null;
    error.value = errorText(err, 'No card with that code - or no connection to check it.');
  } finally {
    busy.value = false;
  }
}

async function setBalance(): Promise<void> {
  if (!found.value) return;
  const n = Math.round(Number(setTo.value));
  if (!(n >= 0)) return void (error.value = 'What should the balance be?');
  busy.value = true;
  error.value = null;
  try {
    const res = await api.setBalance(found.value.member.id, n, 'old card brought over');
    found.value = { ...found.value, member: res.member };
    setting.value = false;
    sdk().ui.toast(`Set to ${n} ${unit(n)}.`, { kind: 'success' });
  } catch (err) {
    error.value = errorText(err, 'Could not set the balance.');
  } finally {
    busy.value = false;
  }
}

function attach(): void {
  if (!found.value) return;
  const m = found.value.member;
  const ok = sdk().till.addLine({ key: LOYALTY_MEMBER_LINE_KEY, name: `${found.value.settings.programme || 'Loyalty card'} · ${m.name || m.code.slice(-4)}`, qty: 1, unitPrice: 0, ref: { kind: LOYALTY_MEMBER_REF_KIND, id: m.id } });
  if (!ok) return void (error.value = 'Open the till with an active event first.');
  sdk().ui.toast(`${m.name || 'The card'} is on this sale.`, { kind: 'success' });
}

function useReward(): void {
  if (!found.value || !settings.value || !standing.value) return;
  if (standing.value.rewards < 1) return void (error.value = `Not enough ${unit(2)} yet.`);
  if (cartTotal.value == null && settings.value.reward.kind !== 'amount') return void (error.value = 'This till cannot say what the sale comes to - update the app to use a percentage or item reward.');
  const amount = rewardValue.value;
  if (!(amount > 0)) return void (error.value = needsPrice.value ? 'Enter the price of the item they are getting.' : 'Put the items in the cart first - the reward comes off them.');
  attach();
  const line = { key: LOYALTY_REWARD_LINE_KEY, name: `Reward · ${rewardLabel(settings.value, money).split(' = ')[1] ?? 'reward'}`, qty: 1, unitPrice: -amount };
  const ok = rewardOnSale.value ? sdk().till.replaceLine(line) : sdk().till.addLine({ ...line, ref: { kind: LOYALTY_REWARD_REF_KIND, id: found.value.member.id } });
  if (!ok) return void (error.value = 'Could not put the reward in the cart.');
  sdk().ui.toast(`${money(amount)} off as the reward.`, { kind: 'success' });
  emit('close');
}
</script>

<template>
  <div class="loyalty">
    <form class="row" @submit.prevent="look">
      <input ref="input" v-model="code" type="text" placeholder="Scan or type the card code (LY-…)" aria-label="Card code" autocomplete="off" spellcheck="false" />
      <button type="submit" class="primary" :disabled="busy">{{ busy ? '…' : 'Look up' }}</button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="onSale && !found" class="hint">{{ onSale.name }} is on this sale.</p>

    <template v-if="found && standing && settings">
      <div class="member">
        <strong>{{ found.member.name || 'Card holder' }}</strong>
        <span class="muted">{{ found.member.code }}</span>
        <p class="big">{{ standing.balance }} <small>{{ unit(standing.balance) }}</small></p>
        <p class="hint">{{ standing.rewards > 0 ? `${standing.rewards} reward${standing.rewards === 1 ? '' : 's'} to use` : `${standing.toNext} more ${unit(standing.toNext)} to the next reward` }} · {{ rewardLabel(settings, money) }}</p>
      </div>
      <div class="actions">
        <button type="button" :disabled="!!onSale && onSale.name.includes(found.member.name || found.member.code.slice(-4))" @click="attach">{{ onSale ? 'On this sale' : 'Put this sale on the card' }}</button>
        <template v-if="standing.rewards > 0">
          <label v-if="needsPrice" class="price"><span>Price of the free item</span><input v-model="itemPrice" type="text" inputmode="decimal" placeholder="0.00" /></label>
          <button type="button" class="primary" @click="useReward">Use a reward{{ rewardValue > 0 ? ` · ${money(rewardValue)} off` : '' }}</button>
        </template>
        <template v-if="found.maySet">
          <button v-if="!setting" type="button" class="quiet" @click="setting = true; setTo = String(standing.balance)">Set the balance (old card brought over)</button>
          <form v-else class="setrow" @submit.prevent="setBalance">
            <input v-model="setTo" type="number" min="0" step="1" aria-label="New balance" />
            <button type="submit" class="primary" :disabled="busy">Set to {{ setTo || 0 }} {{ unit(Number(setTo) || 0) }}</button>
            <button type="button" class="quiet" @click="setting = false">Cancel</button>
          </form>
          <p class="hint">Logged with your name; an admin sees and can change it.</p>
        </template>
      </div>
    </template>
    <p v-else class="hint">The customer's card is the QR on their phone or the code under it. Scanning the QR into the till's search box puts the sale on the card too.</p>
  </div>
</template>

<style scoped>
.loyalty { display: flex; flex-direction: column; gap: .8rem; min-width: min(28rem, 90vw); }
.row { display: flex; gap: .4rem; }
.row input { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .9rem; }
.hint, .muted { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.member { display: flex; flex-direction: column; gap: .15rem; padding: .8rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.big { margin: .2rem 0 0; font-size: 2rem; font-weight: 800; color: var(--zfy-accent-ink, #0a5a4a); line-height: 1.1; }
.big small { font-size: 1rem; font-weight: 600; }
.actions { display: flex; flex-direction: column; gap: .5rem; }
.actions button { min-height: 2.8rem; }
.price { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
.setrow { display: grid; grid-template-columns: 6rem 1fr auto; gap: .4rem; align-items: center; }
.setrow input { min-width: 0; }
</style>
