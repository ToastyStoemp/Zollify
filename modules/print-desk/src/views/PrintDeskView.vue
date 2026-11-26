<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { roleAtLeast } from '@zollify/sdk';
import { Icon } from '@zollify/ui';
import { getConfig, getDesks, getRequests, isArtPrint, patchConfig, sendRequest, sizeFromName, stockKey, targetOf, type Desk, type DeskRequest, type PrintDeskConfig } from '../api';
import { sdk } from '../runtime';

/**
 * Print Desk from any device. Each desk (the desktop app at a printer) reports what it is doing
 * every few seconds; this page shows that, the targets every desk shares, and lets an owner or
 * admin send a desk print counts, or ask it to print - which only happens on a desk that allows
 * printing on request.
 */

const POLL_MS = 5000;
const config = ref<PrintDeskConfig>({});
const desks = ref<Desk[]>([]);
const requests = ref<DeskRequest[]>([]);
const deskId = ref<string | null>(null);
const counts = ref<Record<string, number>>({});
/** Counts changed here and not sent yet: the desk's reports don't overwrite them. */
const edited = ref(false);
const onlySize = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const loaded = ref(false);

const canControl = computed(() => {
  const role = sdk().account()?.role;
  return !!role && roleAtLeast(role, 'admin');
});

async function refresh(withConfig = false): Promise<void> {
  try {
    const [d, r, c] = await Promise.all([getDesks(), getRequests(), withConfig ? getConfig() : Promise.resolve(null)]);
    desks.value = d.desks;
    requests.value = r.requests;
    if (c) config.value = c.config;
    error.value = '';
  } catch (err) {
    error.value = `Could not reach Zollify: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    loaded.value = true;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
let ticks = 0;
onMounted(async () => {
  await refresh(true);
  // Status and requests every few seconds; the shared settings now and then.
  timer = setInterval(() => void refresh(++ticks % 6 === 0), POLL_MS);
});
onBeforeUnmount(() => clearInterval(timer));

/** The desk this page works with: the one picked, else the online desk that reported last. */
const desk = computed(() => desks.value.find((d) => d.deviceId === deskId.value) ?? desks.value.find((d) => d.online) ?? desks.value[0] ?? null);
watch(
  () => [desk.value?.deviceId, desk.value?.counts] as const,
  () => {
    if (!edited.value) counts.value = { ...(desk.value?.counts ?? {}) };
  },
  { immediate: true },
);

interface Item {
  key: string;
  title: string;
  variant: string;
  size: string | null;
  inStock: number;
}
/** The art prints, in the order the desks print them; hidden ones (printed elsewhere) left out. */
const items = computed<Item[]>(() => {
  const inv = sdk().data.inventory;
  const all: Item[] = [];
  for (const p of sdk().data.products.list()) {
    if (!isArtPrint(p.type)) continue;
    const variants = p.variants ?? [];
    if (variants.length) for (const v of variants) all.push({ key: stockKey(p.id, v.id), title: p.title, variant: v.name ?? '', size: sizeFromName(v.name ?? '', p.title), inStock: inv.inStock(p.id, v.id) });
    else all.push({ key: stockKey(p.id, ''), title: p.title, variant: '', size: sizeFromName(p.title), inStock: inv.inStock(p.id, null) });
  }
  const hidden = new Set(config.value.hidden ?? []);
  const at = new Map((config.value.order ?? []).map((k, i) => [k, i]));
  return all
    .filter((i) => !hidden.has(i.key))
    .map((i, n) => ({ i, n }))
    .sort((a, b) => (at.get(a.i.key) ?? 1e6 + a.n) - (at.get(b.i.key) ?? 1e6 + b.n))
    .map(({ i }) => i);
});
const names = computed(() => new Map(items.value.map((i) => [i.key, i.variant ? `${i.title} ${i.variant}` : i.title])));
const nameOf = (key: string): string => names.value.get(key) ?? key;
const sizes = computed(() => [...new Set(items.value.map((i) => i.size).filter((s): s is string => !!s))].sort());
const totalCopies = computed(() => Object.values(counts.value).reduce((n, c) => n + (c || 0), 0));
/** The items of the size picked above the table ('' every size): what the table, Fill to target and Print now go by. */
const shown = computed(() => (onlySize.value ? items.value.filter((i) => i.size === onlySize.value) : items.value));
const shownCopies = computed(() => shown.value.reduce((n, i) => n + (counts.value[i.key] || 0), 0));
// A size no item has any more goes back to every size.
watch(sizes, (s) => {
  if (onlySize.value && !s.includes(onlySize.value)) onlySize.value = '';
});
const running = computed(() => desk.value?.run.filter((r) => !r.done) ?? []);
const finished = computed(() => desk.value?.run.filter((r) => r.done) ?? []);
const copiesLeft = computed(() => running.value.reduce((n, r) => n + r.left, 0));

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString();
};
const label = (size: string): string => (/^a\d$/.test(size) ? size.toUpperCase() : size);

function setCount(key: string, value: number): void {
  counts.value = { ...counts.value, [key]: Math.max(0, Math.min(999, Math.floor(value) || 0)) };
  edited.value = true;
}
/** Counts that bring every item up to its target, from what Zollify says is in stock. */
function fillToTarget(): void {
  // Only the size shown; the other sizes keep their counts.
  const keys = new Set(shown.value.map((i) => i.key));
  const kept = Object.entries(counts.value).filter(([k]) => !keys.has(k));
  const filled = shown.value.map((i) => [i.key, Math.max(0, targetOf(config.value, i.key, i.size) - i.inStock)] as const);
  counts.value = Object.fromEntries([...kept, ...filled].filter(([, n]) => n > 0));
  edited.value = true;
}
function resetCounts(): void {
  counts.value = { ...(desk.value?.counts ?? {}) };
  edited.value = false;
}

async function saveTarget(patch: PrintDeskConfig): Promise<void> {
  try {
    config.value = (await patchConfig(patch)).config;
  } catch (err) {
    error.value = `Could not save the target: ${err instanceof Error ? err.message : String(err)}`;
  }
}
/** An item's own target; an empty box clears it, so the size's or the main target applies. */
function setItemTarget(key: string, value: number): void {
  const next = { ...(config.value.itemTargets ?? {}) };
  if (Number.isNaN(value)) delete next[key];
  else next[key] = Math.max(0, Math.min(999, Math.floor(value)));
  void saveTarget({ itemTargets: next });
}
function setSizeTarget(size: string, value: number): void {
  const next = { ...(config.value.sizeTargets ?? {}) };
  if (Number.isNaN(value)) delete next[size];
  else next[size] = Math.max(0, Math.min(999, Math.floor(value)));
  void saveTarget({ sizeTargets: next });
}

async function sendCounts(): Promise<void> {
  if (!desk.value) return;
  busy.value = true;
  try {
    const clean = Object.fromEntries(Object.entries(counts.value).filter(([, n]) => n > 0));
    await sendRequest({ kind: 'counts', deviceId: desk.value.deviceId, counts: clean });
    edited.value = false;
    notice.value = `Sent to ${desk.value.name}: ${totalCopies.value} copies. It sets them the next time it checks, within a few seconds.`;
    await refresh();
  } catch (err) {
    error.value = `Could not send the counts: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = false;
  }
}
async function printNow(): Promise<void> {
  const d = desk.value;
  if (!d) return;
  const what = onlySize.value ? `the ${label(onlySize.value)} copies` : 'everything';
  if (!window.confirm(`Ask ${d.name} to print ${what} it has queued now? The printer starts as soon as the desk takes the request.`)) return;
  busy.value = true;
  try {
    await sendRequest({ kind: 'print', deviceId: d.deviceId, ...(onlySize.value ? { onlySize: onlySize.value } : {}) });
    notice.value = `Asked ${d.name} to print ${what}.`;
    await refresh();
  } catch (err) {
    error.value = `Could not send the request: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = false;
  }
}
const requestLine = (r: DeskRequest): string => {
  const copies = Object.values(r.payload.counts ?? {}).reduce((n, c) => n + c, 0);
  return r.kind === 'counts' ? `Set counts: ${copies} copies` : `Print ${r.payload.onlySize ? label(r.payload.onlySize) + ' only' : 'everything queued'}`;
};
const STATUS: Record<DeskRequest['status'], string> = { pending: 'waiting for the desk', taken: 'being done', done: 'done', failed: 'failed', refused: 'refused', expired: 'expired' };
</script>

<template>
  <section class="print-desk">
    <header>
      <h1>Print Desk</h1>
      <p class="hint">The desktop app at your printer, from here: what it prints, what it has left, and the targets every desk shares.</p>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="note" role="status">{{ notice }} <button type="button" class="link" @click="notice = ''">Dismiss</button></p>

    <article v-if="loaded && !desks.length" class="card">
      <p>No Print Desk has reported yet. Start Print Desk on the computer at the printer and sign in with this account: it shows up here within a few seconds.</p>
    </article>

    <template v-if="desk">
      <div v-if="desks.length > 1" class="desk-pick" role="group" aria-label="Desk">
        <button v-for="d in desks" :key="d.deviceId" type="button" class="chip" :aria-pressed="d.deviceId === desk.deviceId" @click="deskId = d.deviceId">
          <span :class="['dot', d.online ? 'on' : 'off']" aria-hidden="true"></span>{{ d.name }}
        </button>
      </div>

      <article class="card desk">
        <div class="desk-head">
          <h2><span :class="['dot', desk.online ? 'on' : 'off']" aria-hidden="true"></span>{{ desk.name }}</h2>
          <span class="hint">{{ desk.online ? 'Online' : 'Offline' }} · reported {{ ago(desk.updatedAt) }}</span>
        </div>
        <p class="hint">
          {{ desk.printer || 'Default printer' }}<template v-if="desk.email"> · signed in as {{ desk.email }}</template> ·
          printing on request is <strong>{{ desk.allowRemote ? 'allowed' : 'off' }}</strong><template v-if="!desk.allowRemote"> (switch it on in Print Desk under Setup)</template>
        </p>
        <p v-if="desk.online && desk.waiting" class="waiting" role="status"><Icon name="alert-triangle" :size="16" /> <span><strong>Printer waiting{{ desk.waitingFor ? `: ${desk.waitingFor}` : '' }}</strong> {{ desk.waiting }}</span></p>
        <p v-if="desk.busy" class="note"><Icon name="clock" :size="14" /> {{ desk.busy }}</p>
        <p v-if="desk.error" class="error">{{ desk.error }}</p>

        <div v-if="running.length" class="run">
          <h3>Printing · {{ copiesLeft }} {{ copiesLeft === 1 ? 'copy' : 'copies' }} left</h3>
          <ul class="list">
            <li v-for="r in running" :key="r.key">
              <span class="name">{{ nameOf(r.key) }}</span>
              <progress :max="r.copies" :value="r.printed"></progress>
              <span class="hint">{{ r.printed }} / {{ r.copies }} · {{ r.status }}</span>
            </li>
          </ul>
        </div>
        <div v-if="finished.length" class="run">
          <h3>Last run</h3>
          <ul class="list">
            <li v-for="r in finished" :key="r.key">
              <span class="name">{{ nameOf(r.key) }}</span>
              <span :class="r.failed ? 'error' : r.cancelled ? 'warn' : 'ok'">{{ r.failed || r.cancelled ? r.status : `${r.printed} printed` }}</span>
            </li>
          </ul>
        </div>
        <p v-if="Object.keys(desk.paper).length" class="paper">
          <span class="hint">Paper needed:</span>
          <span v-for="(p, size) in desk.paper" :key="size" :class="['chip', 'static', { short: p.onHand !== null && p.onHand < p.needed }]">
            {{ label(String(size)) }}: {{ p.needed }}<template v-if="p.onHand !== null"> · {{ p.onHand }} on hand</template>
          </span>
        </p>
        <div v-if="desk.supplies?.length" class="supplies">
          <h3>Ink and maintenance</h3>
          <ul>
            <li v-for="s in desk.supplies" :key="s.id" :class="['supply', `is-${s.state}`, { none: s.stock !== undefined && s.stock <= 0 }]" :title="s.material ? `${s.material}: ${s.stock} in stock` : 'No material linked in Print Desk'">
              <span class="tank" :aria-label="`${s.name}: ${s.level}% ${s.kind === 'maintenance' ? 'full' : 'left'}`"><span :style="{ height: `${s.level}%` }"></span></span>
              <span class="sname">{{ s.kind === 'maintenance' ? 'Maint.' : s.name }}</span>
              <span class="hint">{{ s.level }}%{{ s.kind === 'maintenance' ? ' full' : '' }}<template v-if="s.stock !== undefined"> · {{ s.stock }}</template></span>
            </li>
          </ul>
          <p v-for="s in desk.supplies.filter((x) => x.state === 'low' || x.state === 'out')" :key="'w' + s.id" :class="s.stock !== undefined && s.stock <= 0 ? 'error' : 'warn'">
            {{ s.kind === 'maintenance' ? 'Maintenance cartridge' : `${s.name} ink` }} {{ s.kind === 'maintenance' ? (s.state === 'out' ? 'full' : 'nearly full') : s.state === 'out' ? 'empty' : 'low' }}<template v-if="s.stock !== undefined"> - {{ s.stock <= 0 ? `none in stock: order ${s.material}` : `${s.stock} in stock` }}</template>
          </p>
        </div>
      </article>

      <article class="card">
        <div class="desk-head">
          <h2>Copies to print</h2>
          <span class="hint">{{ onlySize ? `${shownCopies} of ${totalCopies}` : totalCopies }} copies{{ edited ? ' · not sent yet' : ` · as ${desk.name} has them` }}</span>
        </div>
        <div v-if="sizes.length > 1" class="desk-pick" role="group" aria-label="Paper size">
          <button type="button" class="chip" :aria-pressed="!onlySize" @click="onlySize = ''">All sizes</button>
          <button v-for="s in sizes" :key="s" type="button" class="chip" :aria-pressed="onlySize === s" @click="onlySize = onlySize === s ? '' : s">{{ label(s) }}</button>
        </div>
        <div v-if="canControl" class="actions">
          <button type="button" class="secondary" @click="fillToTarget">Fill to target</button>
          <button v-if="edited" type="button" class="secondary" @click="resetCounts">Back to the desk's counts</button>
          <button type="button" class="primary" :disabled="busy || !edited" @click="sendCounts">Send counts to {{ desk.name }}</button>
          <span class="spacer"></span>
          <button type="button" class="primary" :disabled="busy || !desk.online || !desk.allowRemote || edited" :title="!desk.allowRemote ? 'Printing on request is off on this desk' : edited ? 'Send the counts first' : ''" @click="printNow">
            <Icon name="printer" :size="14" /> {{ onlySize ? `Print ${label(onlySize)} only` : 'Print now' }}
          </button>
        </div>
        <table>
          <thead>
            <tr><th>Print</th><th>In stock</th><th>Target</th><th>To print</th></tr>
          </thead>
          <tbody>
            <tr v-for="i in shown" :key="i.key">
              <td>{{ i.title }}<span v-if="i.variant" class="hint variant">{{ i.variant }}</span></td>
              <td>{{ i.inStock }}</td>
              <td>
                <input
                  type="number"
                  min="0"
                  max="999"
                  :disabled="!canControl"
                  :aria-label="`Target for ${nameOf(i.key)}`"
                  :value="config.itemTargets?.[i.key] ?? ''"
                  :placeholder="String(targetOf({ ...config, itemTargets: {} }, i.key, i.size))"
                  @change="setItemTarget(i.key, ($event.target as HTMLInputElement).valueAsNumber)"
                />
              </td>
              <td>
                <input type="number" min="0" max="999" :disabled="!canControl" :aria-label="`Copies of ${nameOf(i.key)} to print`" :value="counts[i.key] || ''" @input="setCount(i.key, ($event.target as HTMLInputElement).valueAsNumber)" />
              </td>
            </tr>
          </tbody>
        </table>
        <details v-if="canControl" class="targets">
          <summary>Targets for every item</summary>
          <div class="target-row">
            <label>Main target <input type="number" min="0" max="999" :value="config.target ?? 0" @change="saveTarget({ target: Math.max(0, Math.floor(($event.target as HTMLInputElement).valueAsNumber) || 0) })" /></label>
            <label v-for="s in sizes" :key="s">{{ label(s) }} <input type="number" min="0" max="999" :value="config.sizeTargets?.[s] ?? ''" :placeholder="String(config.target ?? 0)" @change="setSizeTarget(s, ($event.target as HTMLInputElement).valueAsNumber)" /></label>
          </div>
          <p class="hint">An empty size uses the main target; an item's own target (in the table) goes before both. Every desk shares them.</p>
        </details>
      </article>

      <article v-if="requests.length" class="card">
        <h2>Requests</h2>
        <ul class="list">
          <li v-for="r in requests.slice(0, 8)" :key="r.id">
            <span class="name">{{ requestLine(r) }}</span>
            <span :class="['status', r.status]">{{ STATUS[r.status] }}</span>
            <span class="hint">{{ r.result || ago(r.createdAt) }}</span>
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>

<style scoped>
.print-desk { display: flex; flex-direction: column; gap: 1rem; max-width: 56rem; }
header h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: .5rem; }
h3 { margin: 0 0 .3rem; font-size: .85rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.ok { color: var(--zfy-accent-ink, #0a5a4a); }
.note { margin: 0; display: flex; gap: .4rem; align-items: center; font-size: .85rem; }
.supplies ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
.supply { display: flex; flex-direction: column; align-items: center; gap: .15rem; min-width: 2.8rem; font-size: .75rem; }
.supply .tank { width: 1rem; height: 2.4rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 3px; display: flex; align-items: flex-end; overflow: hidden; }
.supply .tank span { display: block; width: 100%; background: var(--zfy-accent, #0e7c66); }
.supply.is-low .tank span, .supply.is-out .tank span { background: var(--zfy-warning-ink, #8a5a1e); }
.supply.none .tank { border-color: var(--zfy-danger, #c6512f); }
.supply .sname { font-weight: 600; }
.supplies p { margin: .3rem 0 0; font-size: .85rem; }
.waiting { margin: 0; display: flex; gap: .5rem; align-items: flex-start; padding: .5rem .7rem; border-radius: 8px; border: 1px solid var(--zfy-warning-ink, #8a5a1e); color: var(--zfy-warning-ink, #8a5a1e); font-size: .88rem; }
.link { border: 0; background: none; padding: 0; text-decoration: underline; cursor: pointer; color: inherit; font-size: .8rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .6rem; }
.desk-head { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
.dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; flex: none; }
.dot.on { background: var(--zfy-accent, #0e7c66); }
.dot.off { background: var(--zfy-muted, #5a6472); opacity: .6; }
.desk-pick, .paper, .actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: 0; }
.actions .spacer { flex: 1; }
.chip { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .65rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 999px; background: none; color: inherit; font-size: .82rem; }
.chip[aria-pressed='true'] { border-color: var(--zfy-accent, #0e7c66); box-shadow: inset 0 0 0 1px var(--zfy-accent, #0e7c66); }
.chip.short { border-color: var(--zfy-danger, #c6512f); color: var(--zfy-danger, #c6512f); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.list li { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; padding: .35rem 0; border-top: 1px solid var(--zfy-line, #d6dde4); }
.list .name { flex: 1 1 10rem; }
.list li:first-child { border-top: 0; }
.list progress { width: 8rem; accent-color: var(--zfy-accent, #0e7c66); }
.status { font-size: .78rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid var(--zfy-line, #d6dde4); }
.status.done { color: var(--zfy-accent-ink, #0a5a4a); }
.status.failed, .status.refused { color: var(--zfy-danger, #c6512f); }
.status.expired { opacity: .7; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .35rem .4rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); vertical-align: middle; }
th { font-size: .78rem; color: var(--zfy-muted, #5a6472); font-weight: 600; }
tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--zfy-ink, #1c232b) 4%, transparent); }
td input { width: 4.5rem; }
.variant { margin-left: .35rem; }
.primary, .secondary { display: inline-flex; align-items: center; gap: .35rem; border-radius: 8px; padding: .45rem .9rem; font-weight: 600; font-size: .85rem; min-height: 2.4rem; cursor: pointer; }
.primary { background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); border: 0; }
.primary:disabled { opacity: .5; cursor: default; }
.secondary { border: 1px solid var(--zfy-line, #d6dde4); background: none; color: inherit; }
.targets summary { cursor: pointer; font-size: .85rem; }
.target-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: .5rem; }
.target-row label { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; }
.target-row input { width: 4.5rem; }
</style>
