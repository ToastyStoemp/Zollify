<script setup lang="ts">
import { computed, ref } from 'vue';
import { allProducts, currentAccount, inventoryRows, recentTransactions, visibleEvents } from '@zollify/platform';
import { isStore, sellsAt } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { useRouter } from 'vue-router';
import { contributions } from '../boot';

/**
 * Getting started, on Home: the few things a new business does before its
 * first good day, each ticking itself off from the data as it happens -
 * nothing to check by hand. It goes away once everything is done, or when
 * the owner hides it.
 */
const account = currentAccount;
const runs = computed(() => sellsAt(account.value?.profile, visibleEvents.value.some((e) => isStore(e))));
const router = useRouter();
/** A module lists consignment artists (the consignment module, when it is on). */
const hasArtists = computed(() => contributions.consignorSources.length > 0 && account.value?.role !== 'member');

interface Step {
  id: string;
  title: string;
  text: string;
  done: boolean;
  to: { name: string; query?: Record<string, string> };
  action: string;
}

const steps = computed<Step[]>(() => {
  const artist = account.value?.profile.artist;
  const products = allProducts.value.length > 0;
  const live = visibleEvents.value.filter((e) => !e.deletedAt);
  const list: Step[] = [
    {
      id: 'profile',
      title: 'Your business details',
      text: 'Address and VAT number - receipts and paperwork print them.',
      done: Boolean(artist?.countryOfOrigin && (artist.street || artist.vatId)),
      to: { name: 'settings', query: { panel: 'core.profile' } },
      action: 'Add details',
    },
    taxStep(),
    {
      id: 'products',
      title: 'Add your products',
      text: 'Titles, prices and sizes. Everything else reads from these.',
      done: products,
      to: { name: 'catalog' },
      action: 'Add products',
    },
    {
      id: 'stock',
      title: 'Count your stock',
      text: 'How many of each you own, so the till knows what is left.',
      done: products && inventoryRows().every((r) => r.counted),
      to: { name: 'stock' },
      action: 'Count',
    },
  ];
  if (runs.value.events) {
    list.push({ id: 'event', title: 'Plan your next event', text: 'Every sale is filed against one.', done: live.some((e) => !isStore(e)), to: { name: 'events' }, action: 'Add event' });
  }
  if (runs.value.stores) {
    list.push({ id: 'store', title: 'Set up your store', text: 'Its VAT, artists and reports.', done: live.some((e) => isStore(e)), to: { name: 'stores' }, action: 'Set up' });
  }
  // A store selling artists' work: the artists come before their items can be tagged or paid out.
  // Only when the consignment module is on and this person can see its artist list (admins).
  if (hasArtists.value && router.hasRoute('consignment:index')) {
    list.push({
      id: 'artists',
      title: 'Add your artists',
      text: 'Who you sell for and their commission - their items, statements and payouts hang on this.',
      done: contributions.consignors().length > 0,
      to: { name: 'consignment:index' },
      action: 'Add artists',
    });
  }
  list.push({
    id: 'card',
    title: 'Take your first card payment',
    text: 'Connect your reader under Payments, then ring up a sale.',
    // A card payment that went through a terminal - not one typed in by hand.
    done: recentTransactions.value.some((t) => (t.payments ?? []).some((p) => p.kind === 'card' && p.provider && p.provider !== 'manual')),
    to: { name: 'settings', query: { panel: 'pos.payments' } },
    action: 'Card terminal',
  });
  return list;
});

/**
 * VAT, by the answer to setup's scheme question: on a scheme, done once the
 * exempt countries are set (in the SME module when it is on); charging VAT,
 * done once there is a VAT number; unanswered, asks the question first.
 */
function taxStep(): Step {
  const vat = account.value?.profile.vat;
  const scheme = vat?.scheme || (vat?.exemptCountries?.length ? 'sme' : '');
  if (scheme === 'sme') {
    return {
      id: 'tax',
      title: 'Set where you are exempt',
      text: 'Your small-business exemption and EX number - until then every sale charges VAT.',
      done: Boolean(vat?.exemptCountries?.length),
      to: { name: 'settings', query: { panel: 'core.vat' } },
      action: 'Set up',
    };
  }
  if (scheme === 'vat') {
    return {
      id: 'tax',
      title: 'Add your VAT numbers',
      text: 'One per country you are registered in - receipts there print it.',
      done: Boolean(vat?.vatNumbers?.length || account.value?.profile.artist.vatId?.trim()),
      to: { name: 'settings', query: { panel: 'core.vat' } },
      action: 'Add',
    };
  }
  return {
    id: 'tax',
    title: 'How do you handle VAT?',
    text: 'Small-business scheme, or charging VAT - one question.',
    done: false,
    to: { name: 'settings', query: { panel: 'core.vat' } },
    action: 'Answer',
  };
}

const doneCount = computed(() => steps.value.filter((s) => s.done).length);
const hideKey = computed(() => `zollify.getting-started.hidden.${account.value?.accountId ?? ''}`);
const readHidden = (): boolean => {
  try {
    return localStorage.getItem(hideKey.value) === '1';
  } catch {
    return false;
  }
};
const hidden = ref(readHidden());
function hide(): void {
  hidden.value = true;
  try {
    localStorage.setItem(hideKey.value, '1');
  } catch {
    /* hidden for this visit only */
  }
}
const show = computed(() => !hidden.value && doneCount.value < steps.value.length);
</script>

<template>
  <article v-if="show" class="card wide getting-started" aria-labelledby="gs-title">
    <header class="gs-head">
      <h2 id="gs-title">Getting started</h2>
      <span class="gs-count">{{ doneCount }} of {{ steps.length }} done</span>
      <button type="button" class="gs-hide" @click="hide">Hide</button>
    </header>
    <div class="gs-bar" role="progressbar" :aria-valuenow="doneCount" aria-valuemin="0" :aria-valuemax="steps.length"><span :style="{ width: `${(doneCount / steps.length) * 100}%` }"></span></div>
    <ol class="gs-steps">
      <li v-for="s in steps" :key="s.id" :class="{ done: s.done }">
        <span class="gs-tick" aria-hidden="true"><Icon v-if="s.done" name="check" :size="14" /></span>
        <span class="gs-body">
          <strong>{{ s.title }}<span v-if="s.done" class="sr-only"> - done</span></strong>
          <small v-if="!s.done">{{ s.text }}</small>
        </span>
        <router-link v-if="!s.done" :to="s.to" class="gs-go">{{ s.action }}</router-link>
      </li>
    </ol>
  </article>
</template>

<style scoped>
.getting-started { display: flex; flex-direction: column; gap: .7rem; }
.gs-head { display: flex; align-items: baseline; gap: .6rem; }
.gs-head h2 { margin: 0; font-size: 1rem; }
.gs-count { color: var(--zfy-muted); font-size: .85rem; }
.gs-hide { margin-left: auto; background: none; border: 0; padding: 0; color: var(--zfy-muted); font: inherit; font-size: .85rem; cursor: pointer; }
.gs-bar { height: 4px; border-radius: 999px; background: var(--zfy-line); overflow: hidden; }
.gs-bar span { display: block; height: 100%; background: var(--zfy-accent); transition: width .3s; }
.gs-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.gs-steps li { display: flex; align-items: center; gap: .7rem; }
.gs-tick { flex: none; display: grid; place-items: center; width: 1.4rem; height: 1.4rem; border-radius: 999px; border: 1px solid var(--zfy-line); color: var(--zfy-on-accent); }
.done .gs-tick { background: var(--zfy-accent); border-color: var(--zfy-accent); }
.gs-body { flex: 1; display: flex; flex-direction: column; gap: .05rem; min-width: 0; }
.gs-body strong { font-size: .9rem; }
.done .gs-body strong { color: var(--zfy-muted); font-weight: 500; text-decoration: line-through; }
.gs-body small { color: var(--zfy-muted); font-size: .8rem; }
.gs-go { flex: none; font-size: .85rem; font-weight: 600; color: var(--zfy-accent-ink); text-decoration: none; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
