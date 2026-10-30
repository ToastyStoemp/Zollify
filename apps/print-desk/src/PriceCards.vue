<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { DiscountRule, Product } from '@zollify/shared';
import type { Session, Settings } from '../electron/shared';
import { CARD_SIZES, DEFAULT_THEMES, cardRows, cardState, cardTexts, changedTexts, shownRows, type CardDef, type CardRow, type CardSize, type CardStyle, type CardState, type CardTheme, type PriceFormat } from '../electron/cards';

/**
 * Price cards: one master card, drawn by PhotoCraft per card from the catalogue and a theme.
 * A card prices whole types, products or variants; new prices go into its PSD in place, so
 * changes made to it by hand in PhotoCraft stay. Ticked cards make A4 sheets.
 */
const props = defineProps<{ settings: Settings; session: Session }>();
const emit = defineEmits<{ settings: [Settings]; error: [string]; notice: [string] }>();

const api = window.printDesk;
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const products = ref<Product[]>([]);
const discounts = ref<DiscountRule[]>([]);
const busy = ref('');
const open = ref<string | null>(null);
const showThemes = ref(false);
const previews = reactive<Record<string, string>>({});
/** Cards ticked for the next sheet, by id; every drawn card to start with. */
const onSheet = reactive<Record<string, boolean>>({});
const pages = ref<{ file: string; preview: string; image: string }[]>([]);
const dir = ref('');
const search = ref('');

const pc = computed(() => props.settings.priceCards);
const themes = computed(() => (pc.value.themes?.length ? pc.value.themes : DEFAULT_THEMES));
const fmt = computed(() => pc.value.format);
const cards = computed(() => pc.value.cards[props.session.accountId] ?? []);
const today = (): string => new Date().toLocaleDateString('sv-SE');

const rowsOf = (def: CardDef): CardRow[] => shownRows(def, allRowsOf(def));
const allRowsOf = (def: CardDef): CardRow[] => cardRows(def, products.value, discounts.value, today());
const stateOf = (def: CardDef): CardState => cardState(def, rowsOf(def), fmt.value);
const themeOf = (def: CardDef): CardTheme => themes.value.find((t) => t.id === def.theme) ?? themes.value[0]!;
const STATE_TEXT: Record<CardState, string> = { new: 'Not drawn yet', current: 'Up to date', prices: 'New prices', layout: 'Rows changed: redraw', empty: 'Prices nothing for sale' };

const types = computed(() => [...new Set(products.value.filter((p) => p.forSale !== false && !p.unlisted && p.type).map((p) => p.type!))].sort());
const listed = computed(() => {
  const q = search.value.trim().toLowerCase();
  return products.value
    .filter((p) => p.forSale !== false && (!q || `${p.title} ${p.type ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => `${a.type} ${a.title}`.localeCompare(`${b.type} ${b.title}`));
});

onMounted(async () => {
  await reload();
  dir.value = await api.cards.dir().catch(() => '');
  for (const c of cards.value) {
    onSheet[c.id] ??= !!c.file;
    void loadPreview(c);
  }
});
watch(
  () => cards.value.map((c) => c.preview).join('|'),
  () => cards.value.forEach((c) => void loadPreview(c)),
);

async function guard(what: string, fn: () => Promise<void>): Promise<void> {
  busy.value = what;
  try {
    await fn();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = '';
  }
}
async function reload(): Promise<void> {
  await guard('Loading prices', async () => {
    ({ products: products.value, discounts: discounts.value } = await api.zollify.priceData());
  });
}
async function loadPreview(c: CardDef): Promise<void> {
  if (!c.preview) return;
  try {
    previews[c.id] = await api.cards.image(c.preview);
  } catch {
    delete previews[c.id];
  }
}

async function save(patch: Partial<Settings['priceCards']>): Promise<void> {
  emit('settings', await api.settings.set({ priceCards: plain({ ...pc.value, ...patch }) }));
}
async function saveCards(next: CardDef[]): Promise<void> {
  await save({ cards: { ...pc.value.cards, [props.session.accountId]: next } });
}
async function patchCard(id: string, patch: Partial<CardDef>): Promise<void> {
  await saveCards(cards.value.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

async function addCard(): Promise<void> {
  const def: CardDef = { id: crypto.randomUUID(), title: 'New card', subtitle: '', theme: themes.value[0]!.id, mascot: '', source: { types: [], items: [] }, labels: {}, hidden: [], notes: null };
  await saveCards([...cards.value, def]);
  open.value = def.id;
}
async function removeCard(def: CardDef): Promise<void> {
  if (!confirm(`Remove the card "${def.title}"? Its PSD stays in the folder.`)) return;
  await saveCards(cards.value.filter((c) => c.id !== def.id));
}
async function move(def: CardDef, by: -1 | 1): Promise<void> {
  const next = [...cards.value];
  const i = next.findIndex((c) => c.id === def.id);
  const j = i + by;
  if (j < 0 || j >= next.length) return;
  [next[i], next[j]] = [next[j]!, next[i]!];
  await saveCards(next);
}

// ── What a card prices ──
const has = (list: string[], v: string): boolean => list.includes(v);
const toggle = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
async function toggleSource(def: CardDef, kind: 'types' | 'items', value: string): Promise<void> {
  const source = { ...def.source, [kind]: toggle(def.source[kind], value) };
  // A card still called "New card" takes the name of the first thing it prices.
  let title = def.title;
  if (title === 'New card') title = kind === 'types' ? value : (products.value.find((p) => value.startsWith(`${p.id}:`))?.title ?? title);
  await patchCard(def.id, { source, title });
}
async function setLabel(def: CardDef, row: CardRow, text: string): Promise<void> {
  const labels = { ...def.labels };
  const own = row.kind === 'line' ? row.label : row.kind === 'note' ? row.text : '';
  if (!text.trim() || text === own) delete labels[row.id];
  else labels[row.id] = text;
  await patchCard(def.id, { labels });
}
const labelOf = (def: CardDef, row: CardRow): string => def.labels[row.id] ?? (row.kind === 'line' ? row.label : row.kind === 'note' ? row.text : '');
const rowText = (row: CardRow): string => {
  const t = cardTexts({ title: '', subtitle: '', rows: [row] }, fmt.value);
  if (row.kind === 'price') return t[row.id]!;
  if (row.kind === 'deal') return `${row.qty} FOR ${t[`${row.id} price`]}`;
  if (row.kind === 'line') return t[`${row.id} price`]!;
  return '';
};
async function setNotes(def: CardDef, text: string | null): Promise<void> {
  await patchCard(def.id, { notes: text === null ? null : text.split('\n').map((l) => l.trim()).filter(Boolean) });
}
async function pickMascot(def: CardDef): Promise<void> {
  const file = await api.cards.pickPng();
  if (file) await patchCard(def.id, { mascot: file });
}

// ── Drawing ──
function mascotOf(def: CardDef): string {
  if (def.mascot === 'none') return '';
  return def.mascot || themeOf(def).mascot;
}
async function draw(def: CardDef): Promise<void> {
  const rows = rowsOf(def);
  if (!rows.length) return emit('error', `"${def.title}" prices nothing for sale: pick a type, product or variant first.`);
  const r = await api.cards.draw(plain({ id: def.id, title: def.title, subtitle: def.subtitle, rows, theme: themeOf(def), mascot: def.style === 'strip' ? '' : mascotOf(def), size: def.size, style: def.style }), plain(fmt.value));
  const texts = cardTexts({ title: def.title, subtitle: def.subtitle, rows, style: def.style }, fmt.value);
  await patchCard(def.id, { file: r.file, preview: r.preview, width: r.width, height: r.height, layout: r.layout, texts });
  onSheet[def.id] = true;
  await loadPreview({ ...def, preview: r.preview });
}
/** New prices into the PSD in place; only the texts that changed, so hand edits elsewhere stay. */
async function updatePrices(def: CardDef): Promise<string[]> {
  const rows = rowsOf(def);
  const changed = changedTexts(def, rows, fmt.value);
  if (!changed.length || !def.file) return [];
  const r = await api.cards.setTexts(def.file, Object.fromEntries(changed));
  const texts = { ...def.texts, ...Object.fromEntries(changed.filter(([name]) => !r.missing.includes(name))) };
  await patchCard(def.id, { texts, preview: r.preview });
  await loadPreview({ ...def, preview: r.preview });
  return r.missing;
}
async function drawOne(def: CardDef): Promise<void> {
  await guard(`Drawing ${def.title}`, () => draw(def));
}
async function updateOne(def: CardDef): Promise<void> {
  await guard(`Updating ${def.title}`, async () => {
    const missing = await updatePrices(def);
    emit('notice', missing.length ? `${def.title}: these layers are no longer in the PSD and were left as they are: ${missing.join(', ')}.` : `${def.title}: prices updated.`);
  });
}
/** Every card up to date: new prices in place, new and changed cards drawn. */
async function updateAll(): Promise<void> {
  let updated = 0;
  let drawn = 0;
  const redraw: string[] = [];
  await guard('Updating cards', async () => {
    for (const def of cards.value) {
      const state = stateOf(def);
      busy.value = `Updating ${def.title}`;
      if (state === 'prices') {
        await updatePrices(def);
        updated++;
      } else if (state === 'new') {
        await draw(def);
        drawn++;
      } else if (state === 'layout') redraw.push(def.title);
    }
  });
  emit(
    'notice',
    [
      updated || drawn ? `${updated} cards updated, ${drawn} drawn.` : 'Every card is up to date.',
      redraw.length ? `Redraw these by hand, their rows changed (a redraw starts the PSD again): ${redraw.join(', ')}.` : '',
    ].join(' '),
  );
}

// ── Sheets ──
const sheetCards = computed(() => cards.value.filter((c) => c.file && c.height && onSheet[c.id]));
async function makeSheets(): Promise<void> {
  await guard('Laying out sheets', async () => {
    const made = await api.cards.sheets(plain(sheetCards.value.map((c) => ({ key: c.id, file: c.file!, width: c.width ?? 1240, height: c.height! }))));
    pages.value = await Promise.all(made.map(async (p) => ({ ...p, image: await api.cards.image(p.preview) })));
    emit('notice', `${made.length} ${made.length === 1 ? 'sheet' : 'sheets'} saved in ${dir.value}.`);
  });
}
async function pdf(file: string): Promise<void> {
  await guard('Saving PDF', async () => emit('notice', `Saved ${await api.cards.pdf(file)}`));
}
async function printPages(files: string[]): Promise<void> {
  await guard('Printing', async () => {
    const results = await api.cards.print(files);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) emit('error', failed.map((r) => r.message).join('; '));
    else emit('notice', `${results.length} ${results.length === 1 ? 'sheet' : 'sheets'} sent to the printer.`);
  });
}
async function openFile(file: string): Promise<void> {
  const why = await api.cards.open(file);
  if (why) emit('error', why);
}

// ── Settings: price format, folder, themes ──
async function setFormat(patch: Partial<PriceFormat>): Promise<void> {
  await save({ format: { ...fmt.value, ...patch } });
}
async function pickDir(): Promise<void> {
  const folder = await api.cards.pickFolder();
  if (!folder) return;
  await save({ outDir: folder });
  dir.value = await api.cards.dir();
}
async function setTheme(id: string, patch: Partial<CardTheme>): Promise<void> {
  await save({ themes: themes.value.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}
async function setColor(t: CardTheme, key: keyof CardTheme['colors'], value: string): Promise<void> {
  await setTheme(t.id, { colors: { ...t.colors, [key]: value.toUpperCase() } });
}
async function themeMascot(t: CardTheme): Promise<void> {
  const file = await api.cards.pickPng();
  if (file) await setTheme(t.id, { mascot: file });
}
async function copyTheme(t: CardTheme): Promise<void> {
  await save({ themes: [...themes.value, { ...plain(t), id: crypto.randomUUID(), name: `${t.name} copy` }] });
}
async function removeTheme(t: CardTheme): Promise<void> {
  if (themes.value.length < 2) return;
  if (cards.value.some((c) => c.theme === t.id) && !confirm(`Cards in "${t.name}" go to the first theme. Remove it?`)) return;
  await save({ themes: themes.value.filter((x) => x.id !== t.id) });
}
const COLOR_NAMES: [keyof CardTheme['colors'], string][] = [
  ['bg', 'Background'],
  ['frame', 'Frame'],
  ['pill', 'Title band'],
  ['title', 'Title'],
  ['ink', 'Text'],
  ['accent', 'Deals'],
  ['sparkle', 'Sparkles'],
];
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
</script>

<template>
  <div class="toolbar">
    <button type="button" class="primary" :disabled="!!busy" @click="addCard">New card</button>
    <button type="button" :disabled="!!busy || !cards.length" @click="updateAll">Update all</button>
    <button type="button" class="quiet" :disabled="!!busy" @click="reload">Reload prices</button>
    <span class="spacer"></span>
    <label class="inline" title="{n} is the price: {n}.- gives 15.-, €{n} gives €15">Price as <input class="pattern" :value="fmt.pattern" @change="setFormat({ pattern: ($event.target as HTMLInputElement).value || '{n}' })" /></label>
    <label class="inline" title="Prices are the catalogue's times this, for an event in another currency">× <input type="number" min="0" step="0.0001" :value="fmt.rate" @change="setFormat({ rate: ($event.target as HTMLInputElement).valueAsNumber || 1 })" /></label>
    <label class="inline" title="Round to this step: 0.5, 1, 5. 0 keeps the cents">Round to <input type="number" min="0" step="0.05" :value="fmt.rounding" @change="setFormat({ rounding: ($event.target as HTMLInputElement).valueAsNumber || 0 })" /></label>
    <button type="button" class="quiet" :aria-pressed="showThemes" @click="showThemes = !showThemes">Themes</button>
  </div>
  <p class="muted folder">
    Card and sheet PSDs go to <code>{{ dir || '…' }}</code> <button type="button" class="quiet" @click="pickDir">Change</button>
    <span v-if="busy" class="busy">{{ busy }}…</span>
  </p>

  <section v-if="showThemes" class="themes" aria-label="Themes">
    <article v-for="t in themes" :key="t.id" class="theme-card" :style="{ background: t.colors.bg, color: t.colors.ink }">
      <input class="theme-name" :value="t.name" aria-label="Theme name" @change="setTheme(t.id, { name: ($event.target as HTMLInputElement).value })" />
      <div class="swatches">
        <label v-for="[key, name] in COLOR_NAMES" :key="key" class="swatch" :title="name">
          <input type="color" :value="t.colors[key]" @change="setColor(t, key, ($event.target as HTMLInputElement).value)" />
          <small>{{ name }}</small>
        </label>
      </div>
      <label class="inline">Font <input :value="t.font" @change="setTheme(t.id, { font: ($event.target as HTMLInputElement).value || 'Bahnschrift' })" /></label>
      <div class="inline-actions">
        <span>Mascot: {{ t.mascot ? fileName(t.mascot) : 'none' }}</span>
        <button type="button" class="quiet" @click="themeMascot(t)">Pick PNG</button>
        <button v-if="t.mascot" type="button" class="quiet" @click="setTheme(t.id, { mascot: '' })">None</button>
      </div>
      <div class="inline-actions">
        <button type="button" class="quiet" @click="copyTheme(t)">Copy</button>
        <button type="button" class="quiet" :disabled="themes.length < 2" @click="removeTheme(t)">Remove</button>
      </div>
    </article>
  </section>

  <p v-if="!cards.length" class="muted">No price cards yet. A card prices a whole product type (all keychains), or single products and variants; New card starts one.</p>

  <ul class="cards">
    <li v-for="(def, i) in cards" :key="def.id" :class="{ open: open === def.id }">
      <div class="card-row">
        <input type="checkbox" :checked="!!onSheet[def.id]" :disabled="!def.file" :title="def.file ? 'On the next sheet' : 'Draw it first'" @change="onSheet[def.id] = ($event.target as HTMLInputElement).checked" />
        <img v-if="previews[def.id]" :src="previews[def.id]" class="thumb" alt="" />
        <span v-else class="thumb empty" :style="{ background: themeOf(def).colors.bg }"></span>
        <div class="what">
          <strong>{{ def.title }}</strong>
          <small class="muted">{{ themeOf(def).name }} · {{ rowsOf(def).map(rowText).filter(Boolean).join(' · ') || 'nothing priced yet' }}</small>
        </div>
        <span class="state" :class="stateOf(def)">{{ STATE_TEXT[stateOf(def)] }}</span>
        <div class="row-actions">
          <button v-if="stateOf(def) === 'prices'" type="button" class="primary" :disabled="!!busy" @click="updateOne(def)">Update prices</button>
          <button type="button" :disabled="!!busy || stateOf(def) === 'empty'" :title="def.file ? 'Draws the card again from scratch: changes made to its PSD by hand go' : 'Draws the card as a PSD'" @click="drawOne(def)">{{ def.file ? 'Redraw' : 'Draw' }}</button>
          <button v-if="def.file" type="button" class="quiet" title="Open the PSD in PhotoCraft to change it by hand" @click="openFile(def.file)">Open</button>
          <button type="button" class="quiet" :aria-pressed="open === def.id" @click="open = open === def.id ? null : def.id">Edit</button>
          <button type="button" class="quiet" :disabled="i === 0" aria-label="Move up" @click="move(def, -1)">↑</button>
          <button type="button" class="quiet" :disabled="i === cards.length - 1" aria-label="Move down" @click="move(def, 1)">↓</button>
        </div>
      </div>

      <div v-if="open === def.id" class="editor">
        <div class="fields">
          <label>{{ def.style === 'strip' ? 'Heading' : 'Title' }} <input :value="def.title" :placeholder="def.style === 'strip' ? 'Available in:' : ''" @change="patchCard(def.id, { title: ($event.target as HTMLInputElement).value })" /></label>
          <label>Style
            <select :value="def.style ?? 'card'" @change="patchCard(def.id, { style: ($event.target as HTMLSelectElement).value as CardStyle })">
              <option value="card">Card: title band, rows under each other</option>
              <option value="strip">Strip: a heading, sizes side by side</option>
            </select>
          </label>
          <label>Size
            <select :value="def.size ?? 'half'" @change="patchCard(def.id, { size: ($event.target as HTMLSelectElement).value as CardSize })">
              <option v-for="(s, id) in CARD_SIZES" :key="id" :value="id">{{ s.label }}</option>
            </select>
          </label>
          <label v-if="def.style !== 'strip'">Small line above the title <input :value="def.subtitle" placeholder="Pin & Charm" @change="patchCard(def.id, { subtitle: ($event.target as HTMLInputElement).value })" /></label>
          <label>Theme
            <select :value="def.theme" @change="patchCard(def.id, { theme: ($event.target as HTMLSelectElement).value })">
              <option v-for="t in themes" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
          </label>
          <div v-if="def.style !== 'strip'" class="mascot">
            <span>Mascot</span>
            <select :value="def.mascot === '' || def.mascot === 'none' ? def.mascot : 'own'" @change="(e) => { const v = (e.target as HTMLSelectElement).value; v === 'own' ? pickMascot(def) : patchCard(def.id, { mascot: v }); }">
              <option value="">The theme's{{ themeOf(def).mascot ? '' : ' (none)' }}</option>
              <option value="none">None</option>
              <option value="own">{{ def.mascot && def.mascot !== 'none' ? fileName(def.mascot) : 'A PNG of its own…' }}</option>
            </select>
          </div>
        </div>

        <div class="columns">
          <section>
            <h3>Prices</h3>
            <p class="muted">Whole types, or single products and variants: keychains share one card, stickers at two prices get a line each or a card each.</p>
            <div class="chips">
              <button v-for="t in types" :key="t" type="button" class="chip" :aria-pressed="has(def.source.types, t)" @click="toggleSource(def, 'types', t)">{{ t }}</button>
            </div>
            <input v-model="search" type="search" placeholder="Find a product" class="find" />
            <ul class="products">
              <li v-for="p in listed" :key="p.id">
                <label class="inline" :title="p.unlisted ? 'Off the price lists: a whole type leaves it out, picked here it counts' : undefined">
                  <input type="checkbox" :checked="has(def.source.items, `${p.id}:`) || (!p.unlisted && !!p.type && has(def.source.types, p.type))" :disabled="!p.unlisted && !!p.type && has(def.source.types, p.type)" @change="toggleSource(def, 'items', `${p.id}:`)" />
                  {{ p.title }} <small class="muted">{{ p.type }}{{ p.unlisted ? ' · off lists' : '' }}</small>
                </label>
                <div v-if="(p.variants ?? []).filter((v) => !v.unlisted).length > 1 && !has(def.source.items, `${p.id}:`) && !(!p.unlisted && p.type && has(def.source.types, p.type))" class="chips variants">
                  <button v-for="v in (p.variants ?? []).filter((v) => !v.unlisted)" :key="v.id" type="button" class="chip" :aria-pressed="has(def.source.items, `${p.id}:${v.id}`)" @click="toggleSource(def, 'items', `${p.id}:${v.id}`)">{{ v.name }}</button>
                </div>
              </li>
            </ul>
          </section>

          <section>
            <h3>Rows</h3>
            <p v-if="!allRowsOf(def).length" class="muted">Pick what this card prices.</p>
            <ul class="rows">
              <li v-for="row in allRowsOf(def)" :key="row.id" :class="{ off: def.hidden.includes(row.id) }">
                <input type="checkbox" :checked="!def.hidden.includes(row.id)" title="On the card" @change="patchCard(def.id, { hidden: toggle(def.hidden, row.id) })" />
                <input v-if="row.kind === 'line' || row.kind === 'note'" class="label" :value="labelOf(def, row)" @change="setLabel(def, row, ($event.target as HTMLInputElement).value)" />
                <span v-else class="label muted">{{ row.kind === 'price' ? 'Price' : 'Deal' }}</span>
                <strong>{{ rowText(row) }}</strong>
              </li>
            </ul>
            <label>
              Small print, one line each
              <textarea rows="3" :value="(def.notes ?? []).join('\n')" :placeholder="def.notes === null ? 'From the price notes of its products' : 'Hahnemühle paper'" @change="setNotes(def, ($event.target as HTMLTextAreaElement).value)"></textarea>
            </label>
            <label class="inline"><input type="checkbox" :checked="def.notes === null" @change="setNotes(def, ($event.target as HTMLInputElement).checked ? null : '')" /> Use the products' price notes</label>
          </section>
        </div>
        <div class="inline-actions">
          <button type="button" class="quiet danger" @click="removeCard(def)">Remove card</button>
        </div>
      </div>
    </li>
  </ul>

  <section v-if="cards.length" class="sheet-bar">
    <span class="muted">{{ sheetCards.length }} cards ticked for the sheet</span>
    <button type="button" class="primary" :disabled="!!busy || !sheetCards.length" @click="makeSheets">Make A4 sheets</button>
    <template v-if="pages.length">
      <button type="button" :disabled="!!busy" @click="printPages(pages.map((p) => p.file))">Print {{ pages.length === 1 ? 'it' : `all ${pages.length}` }}</button>
    </template>
  </section>
  <div v-if="pages.length" class="pages">
    <figure v-for="(p, n) in pages" :key="p.file">
      <img :src="p.image" :alt="`Sheet ${n + 1}`" />
      <figcaption>
        <button type="button" class="quiet" @click="openFile(p.file)">Open</button>
        <button type="button" class="quiet" :disabled="!!busy" @click="pdf(p.file)">PDF</button>
        <button type="button" class="quiet" :disabled="!!busy" @click="printPages([p.file])">Print</button>
      </figcaption>
    </figure>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.spacer { flex: 1; }
.pattern { width: 6rem; }
.folder { margin: 0; font-size: .85rem; }
.busy { margin-left: 1rem; color: var(--zfy-primary); }
.themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: .8rem; }
.theme-card { border-radius: 12px; padding: .8rem; display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--zfy-line); }
.theme-card input:not([type='color']), .theme-card button { color: var(--zfy-ink); }
.theme-name { font-weight: 600; }
.swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: .3rem; }
.swatch { align-items: center; gap: .1rem; }
.swatch input { width: 2.4rem; height: 1.8rem; padding: 0; border: 0; background: none; }
.swatch small { font-size: .65rem; text-align: center; }
.inline-actions { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.cards > li { background: var(--zfy-surface); border-radius: 10px; border: 1px solid var(--zfy-line); }
.cards > li.open { border-color: var(--zfy-primary); }
.card-row { display: flex; align-items: center; gap: .8rem; padding: .5rem .7rem; }
.thumb { width: 4.5rem; height: 3.8rem; object-fit: contain; border-radius: 6px; }
.thumb.empty { display: inline-block; opacity: .6; }
.what { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.what small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-size: .8rem; white-space: nowrap; color: var(--zfy-muted); }
.state.prices, .state.new { color: var(--zfy-primary); }
.state.layout, .state.empty { color: var(--zfy-warning); }
.state.current { color: var(--zfy-success); }
.row-actions { display: flex; gap: .3rem; }
.editor { border-top: 1px solid var(--zfy-line); padding: .8rem; display: flex; flex-direction: column; gap: .8rem; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .6rem; }
.mascot { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
h3 { margin: 0 0 .3rem; font-size: .95rem; }
section > p { margin: 0 0 .5rem; font-size: .85rem; }
.chips { display: flex; flex-wrap: wrap; gap: .3rem; }
.chip { padding: .2rem .6rem; border-radius: 999px; font-size: .8rem; }
.chip[aria-pressed='true'] { border-color: var(--zfy-primary); box-shadow: inset 0 0 0 1px var(--zfy-primary); }
.find { margin: .6rem 0 .3rem; width: 100%; }
.products { list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow: auto; }
.products li { padding: .2rem 0; }
.variants { margin: .2rem 0 .2rem 1.6rem; }
.rows { list-style: none; margin: 0 0 .6rem; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.rows li { display: flex; align-items: center; gap: .5rem; }
.rows li.off { opacity: .45; }
.rows .label { flex: 1; min-width: 0; }
.danger { color: var(--zfy-danger); }
.sheet-bar { display: flex; align-items: center; gap: 1rem; }
.pages { display: flex; gap: 1rem; flex-wrap: wrap; }
.pages figure { margin: 0; background: var(--zfy-surface); border: 1px solid var(--zfy-line); border-radius: 8px; padding: .4rem; }
.pages img { width: 14rem; display: block; }
.pages figcaption { display: flex; justify-content: center; gap: .3rem; }
</style>
