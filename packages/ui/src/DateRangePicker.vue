<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from './icon';

/**
 * Hotel-style date-range picker, ported from ZollTool: first click sets the
 * start, second the end; a click before the start moves the start. Values are
 * ISO `yyyy-mm-dd` (what the data model stores); the user sees `dd/mm/yyyy`.
 * Two months are drawn so a range across a month boundary needs no paging.
 */
const props = withDefaults(defineProps<{ start?: string; end?: string; startLabel?: string; endLabel?: string }>(), {
  start: '',
  end: '',
  startLabel: 'Start',
  endLabel: 'End',
});
const emit = defineEmits<{ 'update:start': [v: string]; 'update:end': [v: string] }>();

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Ymd {
  y: number;
  m: number;
  d: number;
}
function parseISO(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? { y: +m[1]!, m: +m[2]! - 1, d: +m[3]! } : null;
}
const toISO = (y: number, m: number, d: number): string => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function fmtEU(iso: string): string {
  const p = parseISO(iso);
  return p ? `${String(p.d).padStart(2, '0')}/${String(p.m + 1).padStart(2, '0')}/${p.y}` : '';
}
/** Days since epoch — a timezone-free integer for ordering. */
const ord = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m, d) / 86400000);
function ordISO(iso: string): number | null {
  const p = parseISO(iso);
  return p ? ord(p.y, p.m, p.d) : null;
}

const open = ref(false);
const hover = ref<number | null>(null);
const view = ref<{ y: number; m: number }>({ y: 0, m: 0 });
function resetView(): void {
  const base = parseISO(props.start) ?? parseISO(props.end);
  const now = new Date();
  view.value = base ? { y: base.y, m: base.m } : { y: now.getFullYear(), m: now.getMonth() };
}
resetView();
function shiftMonth(delta: number): void {
  const total = view.value.y * 12 + view.value.m + delta;
  view.value = { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
}

interface Cell {
  d: number;
  iso: string;
  ord: number;
}
function monthGrid(y: number, m: number): (Cell | null)[] {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (Cell | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push({ d, iso: toISO(y, m, d), ord: ord(y, m, d) });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
const months = computed(() => {
  const a = view.value;
  const nextTotal = a.y * 12 + a.m + 1;
  const b = { y: Math.floor(nextTotal / 12), m: ((nextTotal % 12) + 12) % 12 };
  return [a, b].map((mm) => ({ ...mm, label: `${MONTHS[mm.m]} ${mm.y}`, cells: monthGrid(mm.y, mm.m) }));
});

const startOrd = computed(() => ordISO(props.start));
const endOrd = computed(() => ordISO(props.end));
const today = (() => {
  const n = new Date();
  return ord(n.getFullYear(), n.getMonth(), n.getDate());
})();

function inRange(o: number): boolean {
  const s = startOrd.value;
  if (s == null) return false;
  const e = endOrd.value ?? (hover.value != null && hover.value >= s ? hover.value : null);
  return e != null && o > Math.min(s, e) && o < Math.max(s, e);
}
const isEdge = (o: number): boolean => startOrd.value === o || endOrd.value === o;

function pick(cell: Cell): void {
  const s = startOrd.value;
  if (s == null || endOrd.value != null) {
    emit('update:start', cell.iso);
    emit('update:end', '');
    hover.value = null;
    return;
  }
  if (cell.ord < s) {
    emit('update:start', cell.iso);
    return;
  }
  emit('update:end', cell.iso);
  hover.value = null;
  open.value = false;
}
function clearAll(): void {
  emit('update:start', '');
  emit('update:end', '');
  hover.value = null;
}
function toggle(): void {
  if (!open.value) resetView();
  open.value = !open.value;
}
watch(
  () => [props.start, props.end],
  () => {
    if (!open.value) resetView();
  },
);

const summary = computed(() => {
  const s = fmtEU(props.start);
  const e = fmtEU(props.end);
  if (s && e) return `${s} → ${e}`;
  if (s) return `${s} → …`;
  return '';
});
</script>

<template>
  <div class="range">
    <button type="button" :class="['trigger', { open }]" @click="toggle">
      <span v-if="summary" class="text">{{ summary }}</span>
      <span v-else class="text placeholder">{{ startLabel }} → {{ endLabel }} (dd/mm/yyyy)</span>
      <span v-if="summary" class="clear" role="button" aria-label="Clear dates" @click.stop="clearAll"><Icon name="x" :size="14" /></span>
      <Icon v-else name="calendar" :size="14" />
    </button>

    <!-- Inline, not floated: never clipped inside a scrolling sheet. -->
    <div v-if="open" class="panel">
      <div class="head">
        <button type="button" class="quiet nav" aria-label="Previous month" @click="shiftMonth(-1)"><Icon name="chevron-left" :size="16" /></button>
        <span>Pick the start, then the end</span>
        <button type="button" class="quiet nav" aria-label="Next month" @click="shiftMonth(1)"><Icon name="chevron-right" :size="16" /></button>
      </div>
      <div class="months">
        <div v-for="mo in months" :key="mo.label" class="month">
          <p>{{ mo.label }}</p>
          <div class="grid">
            <span v-for="w in WEEKDAYS" :key="w" class="wd">{{ w }}</span>
            <template v-for="(cell, i) in mo.cells" :key="i">
              <span v-if="!cell"></span>
              <button v-else type="button" :class="['day', { edge: isEdge(cell.ord), mid: inRange(cell.ord) && !isEdge(cell.ord), today: cell.ord === today && !isEdge(cell.ord) }]" @click="pick(cell)" @mouseenter="hover = cell.ord">
                {{ cell.d }}
              </button>
            </template>
          </div>
        </div>
      </div>
      <div class="foot">
        <button type="button" class="quiet" @click="clearAll">Clear</button>
        <button type="button" @click="open = false">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.range { display: flex; flex-direction: column; gap: .5rem; }
.trigger { display: flex; align-items: center; gap: .5rem; width: 100%; text-align: left; font-weight: 400; color: var(--zfy-ink, #1a2230); }
.trigger.open { border-color: var(--zfy-accent, #0e7c66); }
.text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.placeholder { color: var(--zfy-muted, #5a6472); }
.clear { display: inline-flex; color: var(--zfy-muted, #5a6472); }
.clear:hover { color: var(--zfy-ink, #1a2230); }
.panel { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: .75rem; background: var(--zfy-surface, #fff); box-shadow: 0 12px 28px -16px var(--zfy-shadow, rgba(20,26,34,.35)); }
.head { display: flex; align-items: center; justify-content: space-between; font-size: .75rem; color: var(--zfy-muted, #5a6472); margin-bottom: .5rem; }
.nav { min-height: 1.8rem; padding: .1rem .3rem; }
.months { display: flex; gap: 1rem; flex-wrap: wrap; }
.month { flex: 1 1 14rem; min-width: 0; }
.month p { margin: 0 0 .3rem; text-align: center; font-size: .85rem; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.wd { text-align: center; font-size: .62rem; font-weight: 600; color: var(--zfy-muted, #5a6472); padding: .2rem 0; }
.day { min-height: 2rem; padding: 0; font-size: .78rem; font-weight: 400; border: 0; border-radius: 8px; background: none; color: var(--zfy-ink, #1a2230); }
.day:hover { background: var(--zfy-bg, #f1f4f6); }
.day.edge { background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); font-weight: 700; }
.day.mid { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-radius: 0; }
.day.today { box-shadow: inset 0 0 0 1px var(--zfy-line, #d6dde4); }
.foot { display: flex; justify-content: space-between; margin-top: .6rem; padding-top: .5rem; border-top: 1px solid var(--zfy-line, #d6dde4); }
.foot button { min-height: 1.9rem; font-size: .8rem; }
</style>
