<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Product, Variant } from '@zollify/shared';
import { cashShortcutAmounts, fmtPrice, round2, splitCashPortionAmounts } from '@zollify/shared';
import type { SaleEvent } from '@zollify/sdk';
import { Icon, ModalShell } from '@zollify/ui';
import {
  addLine,
  addMisc,
  appliedDiscounts,
  chargeTotals,
  customDiscountCharged,
  localPrice,
  baseTotal,
  cart,
  checkout,
  clear,
  inCart,
  isConverting,
  itemCount,
  setCustomDiscount,
  setQty,
  subtotal,
  toCharged,
  total,
} from '../cart';
import { getProvider } from '../payments/registry';
import { findSearchMatch, typeColor } from '../search';
import { buildReceiptLines, loadReceiptConfig, printReceipt, printingAvailable } from '../receipt';
import { sdk } from '../runtime';
import ProductThumb from '../components/ProductThumb.vue';

/**
 * The till - ZollTool's POS, screen for screen.
 *
 * Products are browsed by type (one card per type, tap to drill in) or as a
 * flat grid; a search box takes a scanner. Every payment is confirmed on
 * screen: cash counts what was handed over and shows the change, card asks
 * for confirmation (or drives the terminal), split takes both. The last sale
 * can be undone from the counter.
 */

const router = useRouter();
const search = ref('');
const notice = ref<{ text: string; kind: 'ok' | 'bad' } | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: 'ok' | 'bad' = 'ok'): void {
  notice.value = { text, kind };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 2800);
}

const activeEvent = computed(() => sdk().data.events.active());
const products = computed(() => sdk().data.products.forSale());
const providerId = ref('manual');
const provider = computed(() => getProvider(providerId.value as never));
const hasTerminal = computed(() => providerId.value !== 'manual');
const customMethods = ref<string[]>([]);

// ── Terminal connection indicator: polled while the till is open ────────────
const terminalConnected = ref<boolean | null>(null); // null = still checking
const terminalDetail = ref('');
let statusTimer: ReturnType<typeof setInterval> | undefined;
async function refreshTerminalStatus(): Promise<void> {
  if (!hasTerminal.value) return;
  try {
    const s = await provider.value.getStatus();
    terminalConnected.value = s.connected;
    terminalDetail.value = s.detail ?? '';
  } catch (err) {
    terminalConnected.value = false;
    terminalDetail.value = String(err);
  }
}
function tapTerminalState(): void {
  void refreshTerminalStatus();
  const state = terminalConnected.value === true ? 'connected' : terminalConnected.value === false ? 'not connected' : 'checking…';
  toast(`${provider.value.label}: ${terminalDetail.value || state}`, terminalConnected.value ? 'ok' : 'bad');
}

onMounted(async () => {
  providerId.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
  customMethods.value = (await sdk().config.get<string[]>('customMethods')) ?? [];
  const event = activeEvent.value;
  cart.eventId = event?.id ?? null;
  const base = event?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'CHF';
  cart.baseCurrency = base;
  const converting = Boolean(event?.localCurrency && event.exchangeRate);
  cart.currency = converting ? event!.localCurrency! : base;
  cart.exchangeRate = converting ? (event!.exchangeRate ?? null) : null;
  cart.roundingIncrement = event?.roundingIncrement ?? 0;
  cart.priceOverrides = { ...(event?.localPriceOverrides ?? {}) };
  cart.tierOverrides = { ...(event?.localTierOverrides ?? {}) };
  void refreshTerminalStatus();
  statusTimer = setInterval(() => void refreshTerminalStatus(), 5000);
});
onUnmounted(() => {
  clearTimeout(noticeTimer);
  clearInterval(statusTimer);
  clearInterval(heartbeat);
});

const currency = computed(() => cart.currency);
const money = (n: number): string => fmtPrice(n, currency.value);
const price = (pid: string, vid: string | null, base: number): string => money(localPrice(pid, vid, base));

// ── Stock ───────────────────────────────────────────────────────────────────
const availability = computed(() => {
  const event = activeEvent.value;
  if (!event) return new Map<string, number>();
  return new Map(sdk().data.inventory.availability(event.id).map((r) => [`${r.productId}:${r.variantId}`, r.available]));
});
function remaining(pid: string, vid: string | null): number | null {
  if (!activeEvent.value) return null;
  const left = availability.value.get(`${pid}:${vid ?? ''}`);
  return left === undefined ? null : left - inCart(pid, vid);
}
function stockLabel(pid: string, vid: string | null): { text: string; cls: string } {
  const left = remaining(pid, vid);
  if (left === null) return { text: '', cls: '' };
  if (left < 0) return { text: `${-left} over stock`, cls: 'bad' };
  if (left === 0) return { text: 'Out of stock', cls: 'bad' };
  if (left <= 3) return { text: `${left} left`, cls: 'warn' };
  return { text: `${left} in stock`, cls: 'muted' };
}
const productInCart = (p: Product): number => (p.variants?.length ? p.variants.reduce((s, v) => s + inCart(p.id, v.id), 0) : inCart(p.id, null));
/** Units still sellable across a product's sizes; null when no event is active. */
function productLeft(p: Product): number | null {
  if (!activeEvent.value) return null;
  const keys = p.variants?.length ? p.variants.map((v) => v.id) : [null];
  return keys.reduce((s, vid) => s + Math.max(0, remaining(p.id, vid) ?? 0), 0);
}

// ── Browsing: by type, or flat ──────────────────────────────────────────────
const VIEW_KEY = 'zollify.pos.view';
const viewMode = ref<'flat' | 'grouped'>('grouped');
try {
  if (localStorage.getItem(VIEW_KEY) === 'flat') viewMode.value = 'flat';
} catch {
  /* no storage */
}
function setViewMode(mode: 'flat' | 'grouped'): void {
  viewMode.value = mode;
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* no storage */
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return products.value;
  return products.value.filter((p) =>
    [p.title, p.sku, p.type, ...(p.variants ?? []).flatMap((v) => [v.name, v.sku])].filter(Boolean).join(' ').toLowerCase().includes(q),
  );
});
/** Searching always shows flat results; grouping is for browsing. */
const grouped = computed(() => viewMode.value === 'grouped' && !search.value.trim());

interface TypeGroup {
  type: string;
  products: Product[];
  stock: number | null;
  inCart: number;
}
const typeGroups = computed<TypeGroup[]>(() => {
  const map = new Map<string, Product[]>();
  for (const p of products.value) (map.get(p.type || '(no type)') ?? map.set(p.type || '(no type)', []).get(p.type || '(no type)')!).push(p);
  return [...map.entries()].map(([type, list]) => ({
    type,
    products: list,
    stock: activeEvent.value ? list.reduce((s, p) => s + (productLeft(p) ?? 0), 0) : null,
    inCart: list.reduce((s, p) => s + productInCart(p), 0),
  }));
});
type Entry = { key: string; product: Product } | { key: string; group: TypeGroup };
const entries = computed<Entry[]>(() => {
  if (!grouped.value) return filtered.value.map((p) => ({ key: p.id, product: p }));
  return typeGroups.value.map((g) => (g.products.length === 1 ? { key: g.products[0]!.id, product: g.products[0]! } : { key: `t:${g.type}`, group: g }));
});
const openType = ref<string | null>(null);
const typeProducts = computed(() => (openType.value === null ? [] : products.value.filter((p) => (p.type || '(no type)') === openType.value)));

function submitSearch(): void {
  const match = findSearchMatch(products.value, search.value);
  if (!match) return toast('No product found for that search.', 'bad');
  if ('ambiguous' in match) return toast(`${match.count} matches - keep typing to narrow it down.`, 'bad');
  add(match.productId, match.variantId);
  toast(`Added ${match.label}`);
  search.value = '';
}

// ── Barcode scanner (camera) ─────────────────────────────────────────────────
// Native BarcodeDetector rather than a bundled decoder library: our own
// labels are Code128 (see @zollify/label-printer), which it covers, and it
// needs no dependency - Chrome/Edge desktop and Android support it, same
// browsers this app already requires elsewhere (Web Bluetooth). Not in the
// standard DOM types yet, hence the local shape below instead of `any`.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}
/** focusMode/zoom aren't in the standard MediaTrackConstraints type yet either, same reasoning as BarcodeDetectorLike above. */
interface ScannerVideoConstraints extends MediaTrackConstraints {
  advanced?: (MediaTrackConstraintSet & { focusMode?: string; zoom?: number })[];
}
const scannerSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;
const scannerOpen = ref(false);
const scannerError = ref<string | null>(null);
const scannerVideo = ref<HTMLVideoElement | null>(null);
let scannerStream: MediaStream | null = null;
let scannerTimer: ReturnType<typeof setInterval> | undefined;

async function openScanner(): Promise<void> {
  if (!scannerSupported) return toast('Barcode scanning needs a newer Chrome or Edge - not available on this device.', 'bad');
  scannerError.value = null;
  scannerOpen.value = true;
  await nextTick();
  try {
    // width/height ideal: without them some phones hand back their full
    // sensor resolution, which is slower to run detect() on every tick and,
    // combined with the video element's CSS box, is part of what read as
    // "zoomed in". focusMode/zoom are non-standard, so they're inside
    // `advanced` - a browser that doesn't understand them ignores them
    // instead of rejecting the whole request. Confirmed live only that they
    // don't break anything on desktop Chrome (no rear camera to test the
    // actual effect); the "doesn't autofocus, doesn't scan" report is
    // exactly what a phone defaulting to a fixed-focus or 2x-tele capture
    // for video calls would look like.
    const videoConstraints: ScannerVideoConstraints = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      advanced: [{ focusMode: 'continuous' }, { zoom: 1 }],
    };
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
    const video = scannerVideo.value;
    if (!video) throw new Error('Could not open the camera view.');
    video.srcObject = scannerStream;
    await video.play();

    const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Detector({ formats: ['code_128'] });
    scannerTimer = setInterval(() => {
      if (!scannerVideo.value || scannerVideo.value.readyState < 2) return;
      detector
        .detect(scannerVideo.value)
        .then((codes) => {
          const value = codes[0]?.rawValue;
          if (!value) return;
          closeScanner();
          search.value = value;
          submitSearch();
        })
        .catch(() => undefined); // one bad frame - try the next tick
    }, 300);
  } catch (err) {
    scannerError.value = err instanceof Error ? err.message : 'Could not access the camera.';
  }
}

function closeScanner(): void {
  scannerOpen.value = false;
  clearInterval(scannerTimer);
  scannerTimer = undefined;
  scannerStream?.getTracks().forEach((t) => t.stop());
  scannerStream = null;
}
onUnmounted(closeScanner);

// ── Adding ──────────────────────────────────────────────────────────────────
const variantPicker = ref<Product | null>(null);

function add(pid: string, vid: string | null): void {
  const p = products.value.find((x) => x.id === pid);
  if (!p) return;
  const variants = (p.variants ?? []).filter((v) => !v.unlisted);
  if (variants.length && !vid) {
    variantPicker.value = p;
    return;
  }
  const v = vid ? variants.find((x) => x.id === vid) : undefined;
  addLine({
    productId: p.id,
    variantId: v?.id ?? null,
    variantLabel: v?.name ?? null,
    sku: v?.sku ?? p.sku ?? null,
    name: v ? `${p.title} · ${v.name}` : p.title,
    qty: 1,
    unitPrice: v?.price ?? p.price,
    taxRate: p.vatRate ?? null,
    type: p.type,
  });
}

/** Tier quantities of tiered rules on this product drive the "+3 / +5" chips. */
function bundleQtys(p: Product, vid: string | null = null): number[] {
  const qtys = new Set<number>();
  for (const rule of sdk().data.discounts.active()) {
    if (rule.type !== 'tiered' || !rule.tiers?.length || rule.hideQuickAdd) continue;
    const matches = rule.productIds.includes(p.id) || (!!p.type && (rule.productTypes ?? []).includes(p.type)) || (vid !== null && rule.variantIds.includes(`${p.id}:${vid}`));
    if (!matches) continue;
    for (const t of rule.tiers) if (t.qty > 1) qtys.add(t.qty);
  }
  return [...qtys].sort((a, b) => a - b).slice(0, 3);
}
function addBundle(pid: string, vid: string | null, qty: number): void {
  for (let i = 0; i < qty; i++) add(pid, vid);
}

const fromPrice = (p: Product): string => `from ${money(Math.min(...(p.variants ?? []).map((v) => localPrice(p.id, v.id, v.price ?? p.price))))}`;

// ── Cart ────────────────────────────────────────────────────────────────────
const showCartSheet = ref(false);
const lines = computed(() =>
  cart.lines.map((l) => {
    const chargedUnit = localPrice(l.productId, l.variantId, l.unitPrice);
    return { ...l, chargedUnit, chargedTotal: round2(chargedUnit * l.qty) };
  }),
);

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

const showDiscount = ref(false);
const discountForm = reactive({ type: 'amount' as 'amount' | 'percent', value: '', name: '' });
function openDiscount(): void {
  discountForm.type = cart.custom?.type ?? 'amount';
  discountForm.value = cart.custom ? String(cart.custom.value) : '';
  discountForm.name = cart.custom?.name ?? '';
  showDiscount.value = true;
}
function applyDiscount(): void {
  const value = Number(discountForm.value);
  if (!Number.isFinite(value) || value <= 0) return toast('Enter a discount value.', 'bad');
  if (discountForm.type === 'percent' && value > 100) return toast('Percent discount cannot be over 100%.', 'bad');
  setCustomDiscount({ type: discountForm.type, value, name: discountForm.name.trim() || (discountForm.type === 'percent' ? `${value}% off` : 'Discount') });
  showDiscount.value = false;
}

const showMisc = ref(false);
const miscForm = reactive({ title: '', price: '', qty: '1' });
function openMisc(): void {
  Object.assign(miscForm, { title: '', price: '', qty: '1' });
  showMisc.value = true;
}
function addMiscItem(): void {
  const p = Number(miscForm.price);
  const qty = Math.max(1, Math.floor(Number(miscForm.qty)) || 1);
  if (!Number.isFinite(p) || p <= 0) return toast('Enter a price for the item.', 'bad');
  // Entered in the charge currency; the cart keeps base-currency lines.
  addMisc(miscForm.title, round2(isConverting.value && cart.exchangeRate ? p / cart.exchangeRate : p), qty);
  showMisc.value = false;
}

// ── Customer display: mirror the cart on the account's other screens ───────
let publishTimer: ReturnType<typeof setTimeout> | undefined;
function publish(paid?: { total: number }): void {
  sdk().display.publish({
    deviceName: '',
    eventName: activeEvent.value?.name ?? '',
    currency: currency.value,
    lines: paid ? [] : lines.value.map((l) => ({ title: l.name, variantLabel: l.variantLabel ?? undefined, qty: l.qty, lineTotal: l.chargedTotal })),
    discounts: paid
      ? []
      : [...appliedDiscounts.value.map((r) => ({ name: r.rule.name, amount: r.amount })), ...(cart.custom && customDiscountCharged.value > 0 ? [{ name: cart.custom.name, amount: customDiscountCharged.value }] : [])],
    total: paid ? paid.total : total.value,
    paid,
    ts: Date.now(),
  });
}
watch(
  () => [cart.lines.map((l) => `${l.lineId}:${l.qty}`).join(','), cart.custom?.value, total.value],
  () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      // Don't clobber the post-sale thank-you with the emptied cart.
      if (Date.now() < thankYouUntil && !cart.lines.length) return;
      publish();
    }, 150);
  },
);
// Sends are fire-and-forget; a heartbeat re-publishes so a dropped frame self-heals within one interval.
let thankYouUntil = 0;
const heartbeat = setInterval(() => {
  if (Date.now() < thankYouUntil) return;
  publish();
}, 15_000);
onUnmounted(() => clearTimeout(publishTimer));

// ── Today ───────────────────────────────────────────────────────────────────
const today = computed(() => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let count = 0;
  let revenue = 0;
  for (const tx of sdk().data.transactions.recent()) {
    if (tx.revertedAt || tx.timestamp < start.getTime() || (activeEvent.value && tx.eventId !== activeEvent.value.id)) continue;
    count++;
    revenue += tx.baseTotal ?? tx.total;
  }
  return { count, revenue };
});

// ── Last sale: undo or reprint without leaving the counter ─────────────────
const lastSale = ref<{ id: string; total: number; currency: string; units: number } | null>(null);
let lastSaleTimer: ReturnType<typeof setTimeout> | undefined;
async function undoLast(): Promise<void> {
  if (!lastSale.value) return;
  await sdk().data.transactions.revert(lastSale.value.id);
  lastSale.value = null;
  toast('Sale reverted - stock restored');
}
function receipt(): void {
  if (lastSale.value) void router.push({ name: 'pos:receipt', params: { saleId: lastSale.value.id } });
}

// ── Payment ─────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'confirm' | 'terminal' | 'failed' | 'needsLogin';
const payment = reactive({ phase: 'idle' as Phase, method: 'cash' as string, total: 0, cashReceived: '', splitCash: '', splitCard: '', error: '' });

const cashShortcuts = computed(() => (payment.method === 'cash' ? cashShortcutAmounts(payment.total, currency.value) : []));
const splitCashShortcuts = computed(() => splitCashPortionAmounts(Math.max(0, payment.total - (Number(payment.splitCard) || 0)), currency.value));
const change = computed(() => round2((Number(payment.cashReceived) || 0) - payment.total));
const splitState = computed(() => {
  const cash = Number(payment.splitCash) || 0;
  const card = Number(payment.splitCard) || 0;
  const rem = round2(payment.total - cash - card);
  if (rem > 0.001) return { ok: false, label: 'Remaining', amount: rem, cls: 'bad' };
  if (rem < -0.001) return { ok: false, label: 'Over by', amount: -rem, cls: 'warn' };
  return { ok: cash > 0 || card > 0, label: 'Paid', amount: cash + card, cls: 'good' };
});
const confirmDisabled = computed(() => {
  if (payment.method === 'cash') return (Number(payment.cashReceived) || 0) < payment.total - 0.001;
  if (payment.method === 'split') return !splitState.value.ok;
  return false;
});
const title = computed(() => ({ cash: 'Cash payment', card: 'Card payment', split: 'Split payment' })[payment.method] ?? `${payment.method} payment`);

function startPayment(method: string): void {
  if (!itemCount.value) return;
  if (!activeEvent.value) return toast('Pick an active event first (Events).', 'bad');
  payment.method = method;
  payment.total = total.value;
  payment.cashReceived = payment.total.toFixed(2);
  payment.splitCash = '';
  payment.splitCard = '';
  payment.error = '';
  logSent.value = false;
  if (method === 'card' && hasTerminal.value) {
    void beginCardPayment();
    return;
  }
  payment.phase = 'confirm';
}

/** A reader that needs an interactive sign-in (SumUp) and isn't signed in gets a connect-or-choose screen instead of a failing terminal call. */
async function beginCardPayment(): Promise<void> {
  try {
    if (await provider.value.needsLogin?.()) {
      payment.phase = 'needsLogin';
      return;
    }
  } catch {
    /* if the check itself fails, let the terminal report it */
  }
  payment.phase = 'terminal';
  void runTerminal();
}
async function connectReader(): Promise<void> {
  const p = provider.value;
  if (!p.configure) return;
  try {
    await p.configure();
  } catch (err) {
    return toast(err instanceof Error ? err.message : String(err), 'bad');
  }
  if (await p.needsLogin?.()) return toast(`Still not signed in to ${p.label}`, 'bad');
  void refreshTerminalStatus();
  payment.phase = 'terminal';
  void runTerminal();
}

// ── Support: send the diagnostic log straight from a failed payment ─────────
const sendingLog = ref(false);
const logSent = ref(false);
async function sendLog(): Promise<void> {
  sendingLog.value = true;
  try {
    await sdk().diagnostics.sendLog('payment-failed');
    logSent.value = true;
  } catch (err) {
    toast(`Send failed: ${err instanceof Error ? err.message : String(err)}`, 'bad');
  } finally {
    sendingLog.value = false;
  }
}

async function runTerminal(): Promise<void> {
  const outcome = await checkout(crypto.randomUUID(), { method: 'card', terminal: { providerId: providerId.value } });
  if (payment.phase !== 'terminal') return;
  if (outcome.approved) finish(outcome.sale!, `Card approved${outcome.sale?.payment.cardBrand ? ` · ${outcome.sale.payment.cardBrand}` : ''}`);
  else {
    payment.error = outcome.error ?? 'Card payment declined';
    payment.phase = 'failed';
  }
}

async function confirmPayment(): Promise<void> {
  let legs: { kind: 'cash' | 'card'; amount: number }[] | undefined;
  if (payment.method === 'split') {
    legs = [
      { kind: 'cash' as const, amount: Math.max(0, Number(payment.splitCash) || 0) },
      { kind: 'card' as const, amount: Math.max(0, Number(payment.splitCard) || 0) },
    ].filter((l) => l.amount > 0);
  }
  const outcome = await checkout(crypto.randomUUID(), {
    method: payment.method,
    legs,
    cashReceived: payment.method === 'cash' ? Number(payment.cashReceived) || undefined : undefined,
  });
  if (!outcome.approved) return toast(outcome.error ?? 'Could not record the sale.', 'bad');
  const count = outcome.sale!.lines.reduce((s, l) => s + l.qty, 0);
  finish(outcome.sale!, `Payment confirmed - ${count} item${count === 1 ? '' : 's'} sold`);
}

function finish(sale: SaleEvent, message: string): void {
  payment.phase = 'idle';
  showCartSheet.value = false;
  // The transaction row lands a tick later; the sale itself has all the bar needs.
  lastSale.value = { id: sale.saleId, total: sale.total, currency: sale.currency, units: sale.lines.reduce((s, l) => s + l.qty, 0) };
  // The bar answers "did that go through?"; after that it is in the way of
  // the next customer. Undo and the receipt stay reachable from History.
  clearTimeout(lastSaleTimer);
  lastSaleTimer = setTimeout(() => { lastSale.value = null; }, 8000);
  toast(message);
  clearTimeout(publishTimer);
  thankYouUntil = Date.now() + 6000;
  publish({ total: sale.total });
  void autoPrint(sale.saleId);
}

/** Prints the receipt on the paired printer when Settings asks for it; never blocks the till. */
async function autoPrint(saleId: string): Promise<void> {
  try {
    const config = await loadReceiptConfig();
    if (!config.autoPrint || !(await printingAvailable())) return;
    // The row is written by core a tick after the event fires.
    let tx = sdk().data.transactions.get(saleId);
    for (let i = 0; !tx && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      tx = sdk().data.transactions.get(saleId);
    }
    if (!tx) return;
    const result = await printReceipt(buildReceiptLines(tx, activeEvent.value?.name ?? '', config, activeEvent.value?.venue?.country));
    if (!result.printed) toast(`Receipt: ${result.error ?? 'print failed'}`, 'bad');
  } catch (err) {
    toast(`Receipt: ${err instanceof Error ? err.message : String(err)}`, 'bad');
  }
}

async function cancelPayment(): Promise<void> {
  if (payment.phase === 'terminal') await provider.value.cancel().catch(() => {});
  payment.phase = 'idle';
}
</script>

<template>
  <div class="pos">
    <section class="floor">
      <header class="bar">
        <router-link :to="{ name: 'events' }" class="quiet iconbtn" aria-label="Events"><Icon name="arrow-left" :size="16" /></router-link>
        <div class="event">
          <h1 v-if="activeEvent">{{ activeEvent.name }}</h1>
          <h1 v-else class="warn">No active event</h1>
          <small v-if="activeEvent">Today {{ today.count }} sale{{ today.count === 1 ? '' : 's' }} · {{ fmtPrice(today.revenue, cart.baseCurrency) }}</small>
          <small v-else>Open one under Events - sales are filed against an event.</small>
        </div>
        <router-link v-if="activeEvent" :to="{ name: 'history', query: { event: activeEvent.id, from: 'pos' } }" class="quiet iconbtn" aria-label="Sales history"><Icon name="bar-chart" :size="16" /></router-link>
        <button v-if="hasTerminal" type="button" class="quiet terminal" :title="`${provider.label} - tap to re-check`" @click="tapTerminalState">
          <Icon name="credit-card" :size="16" /><span :class="['dot', terminalConnected === true ? 'on' : terminalConnected === false ? 'off' : 'checking']"></span>
        </button>
        <div class="search-group">
          <input v-model="search" class="search" type="search" placeholder="Search / scan…" aria-label="Search or scan" @keydown.enter.prevent="submitSearch" />
          <button type="button" class="quiet iconbtn" aria-label="Scan barcode" title="Scan barcode" @click="openScanner"><Icon name="scan" :size="16" /></button>
        </div>
        <div class="modes">
          <button type="button" :class="['pill', { active: viewMode === 'flat' }]" @click="setViewMode('flat')">All</button>
          <button type="button" :class="['pill', { active: viewMode === 'grouped' }]" @click="setViewMode('grouped')">Types</button>
        </div>
      </header>

      <p v-if="notice" :class="['notice', notice.kind]" role="status">{{ notice.text }}</p>

      <div v-if="lastSale" class="last">
        <Icon name="check" :size="16" />
        <span>{{ fmtPrice(lastSale.total, lastSale.currency) }} · {{ lastSale.units }} item{{ lastSale.units === 1 ? '' : 's' }}</span>
        <span class="spacer"></span>
        <button type="button" class="quiet" @click="receipt"><Icon name="printer" :size="14" /> Receipt</button>
        <button type="button" class="quiet undo" @click="undoLast"><Icon name="undo" :size="14" /> Undo</button>
        <button type="button" class="quiet" aria-label="Dismiss" @click="lastSale = null"><Icon name="x" :size="14" /></button>
      </div>

      <p v-if="!entries.length" class="empty">{{ search ? 'Nothing matches that search.' : 'No products for sale yet - add some under Products.' }}</p>
      <div v-else class="grid">
        <template v-for="e in entries" :key="e.key">
          <button v-if="'group' in e" type="button" class="tile type" :aria-label="`${e.group.type}, ${e.group.products.length} products`" :style="{ borderLeftColor: typeColor(e.group.type) }" :class="{ dim: e.group.stock === 0 }" @click="openType = e.group.type">
            <span v-if="e.group.inCart" class="count">{{ e.group.inCart }}</span>
            <span class="title" :style="{ color: typeColor(e.group.type) }">{{ e.group.type }}</span>
            <small>{{ e.group.products.length }} products</small>
            <span class="foot">
              <span :class="e.group.stock === 0 ? 'bad' : 'muted'">{{ e.group.stock === null ? '' : e.group.stock === 0 ? 'Out of stock' : `${e.group.stock} in stock` }}</span>
              <Icon name="chevron-right" :size="14" />
            </span>
          </button>
          <button v-else type="button" class="tile" :aria-label="e.product.title || 'Untitled product'" :style="{ borderLeftColor: typeColor(e.product.type) }" :class="{ dim: (productLeft(e.product) ?? 1) <= 0 }" @click="add(e.product.id, null)">
            <span v-if="productInCart(e.product)" class="count">{{ productInCart(e.product) }}</span>
            <span class="head">
              <ProductThumb v-if="e.product.imageId" :image-id="e.product.imageId" :alt="e.product.title" :size="36" />
              <span class="title">{{ e.product.title || '(untitled)' }}</span>
            </span>
            <small v-if="e.product.sku">{{ e.product.sku }}</small>
            <span v-if="!e.product.variants?.length && bundleQtys(e.product).length" class="bundles">
              <span v-for="q in bundleQtys(e.product)" :key="q" role="button" class="bundle" @click.stop="addBundle(e.product.id, null, q)">+{{ q }}</span>
            </span>
            <span class="foot">
              <span :class="stockLabel(e.product.id, null).cls">{{ e.product.variants?.length ? `${e.product.variants.length} sizes` : stockLabel(e.product.id, null).text }}</span>
              <strong>{{ e.product.variants?.length ? fromPrice(e.product) : price(e.product.id, null, e.product.price) }}</strong>
            </span>
          </button>
        </template>
      </div>

      <button v-if="itemCount" type="button" class="primary cartbar" @click="showCartSheet = true">
        <span><Icon name="shopping-cart" :size="16" /> {{ itemCount }} item{{ itemCount !== 1 ? 's' : '' }}</span>
        <span>{{ money(total) }}</span>
      </button>
    </section>

    <!-- ── Cart ─────────────────────────────────────────────────────────── -->
    <aside :class="['cart', { sheet: showCartSheet }]">
      <header>
        <h2>Cart</h2>
        <button v-if="itemCount" type="button" :class="['quiet', 'clear', { armed: clearArmed }]" @click="tapClear">{{ clearArmed ? 'Really clear?' : 'Clear' }}</button>
        <button type="button" class="quiet close" aria-label="Close cart" @click="showCartSheet = false"><Icon name="x" :size="18" /></button>
      </header>

      <div class="lines">
        <p v-if="!lines.length" class="empty">Cart is empty</p>
        <ul v-else>
          <li v-for="l in lines" :key="l.lineId">
            <div class="row"><span class="name">{{ l.name }}</span><strong>{{ money(l.chargedTotal) }}</strong></div>
            <div class="row qty">
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
          <div v-if="isConverting" class="row muted small"><span>{{ cart.baseCurrency }} equivalent</span><span>{{ fmtPrice(baseTotal, cart.baseCurrency) }}</span></div>
        </div>
        <div class="tools">
          <button type="button" :disabled="!itemCount" @click="openDiscount">{{ cart.custom ? 'Edit discount' : '+ Discount' }}</button>
          <button type="button" @click="openMisc">+ Misc item</button>
        </div>
        <div class="pay">
          <button type="button" class="cash" :disabled="!itemCount" @click="startPayment('cash')">Cash</button>
          <button type="button" class="card" :disabled="!itemCount" @click="startPayment('card')">Card</button>
          <button type="button" class="split" :disabled="!itemCount" @click="startPayment('split')">Split</button>
          <button v-for="m in customMethods" :key="m" type="button" class="custom" :disabled="!itemCount" @click="startPayment(m)">{{ m }}</button>
        </div>
      </footer>
    </aside>

    <!-- ── Type drill-down ───────────────────────────────────────────────── -->
    <ModalShell v-if="openType" :title="openType" wide @close="openType = null">
      <div class="grid inmodal">
        <button v-for="p in typeProducts" :key="p.id" type="button" class="tile" :aria-label="p.title || 'Untitled product'" :style="{ borderLeftColor: typeColor(p.type) }" @click="add(p.id, null)">
          <span v-if="productInCart(p)" class="count">{{ productInCart(p) }}</span>
          <span class="head">
            <ProductThumb v-if="p.imageId" :image-id="p.imageId" :alt="p.title" :size="36" />
            <span class="title">{{ p.title || '(untitled)' }}</span>
          </span>
          <small v-if="p.sku">{{ p.sku }}</small>
          <span v-if="!p.variants?.length && bundleQtys(p).length" class="bundles">
            <span v-for="q in bundleQtys(p)" :key="q" role="button" class="bundle" @click.stop="addBundle(p.id, null, q)">+{{ q }}</span>
          </span>
          <span class="foot">
            <span :class="stockLabel(p.id, null).cls">{{ p.variants?.length ? `${p.variants.length} sizes` : stockLabel(p.id, null).text }}</span>
            <strong>{{ p.variants?.length ? fromPrice(p) : price(p.id, null, p.price) }}</strong>
          </span>
        </button>
      </div>
    </ModalShell>

    <!-- ── Variant picker (stays open for several sizes in a row) ────────── -->
    <ModalShell v-if="variantPicker" :title="variantPicker.title || 'Choose a variant'" @close="variantPicker = null">
      <div class="grid inmodal">
        <button v-for="v in (variantPicker.variants ?? []).filter((x: Variant) => !x.unlisted)" :key="v.id" type="button" class="tile" :aria-label="v.name || 'Variant'" @click="add(variantPicker!.id, v.id)">
          <span v-if="inCart(variantPicker.id, v.id)" class="count">{{ inCart(variantPicker.id, v.id) }}</span>
          <span class="head">
            <!-- Only the variant's own photo - the product's would misrepresent the variant. -->
            <ProductThumb v-if="v.imageId" :image-id="v.imageId" :alt="v.name" :size="36" />
            <span class="title">{{ v.name || '(untitled)' }}</span>
          </span>
          <small v-if="v.sku">{{ v.sku }}</small>
          <span v-if="bundleQtys(variantPicker, v.id).length" class="bundles">
            <span v-for="q in bundleQtys(variantPicker, v.id)" :key="q" role="button" class="bundle" @click.stop="addBundle(variantPicker!.id, v.id, q)">+{{ q }}</span>
          </span>
          <span class="foot">
            <span :class="stockLabel(variantPicker.id, v.id).cls">{{ stockLabel(variantPicker.id, v.id).text }}</span>
            <strong>{{ price(variantPicker.id, v.id, v.price ?? variantPicker.price) }}</strong>
          </span>
        </button>
      </div>
    </ModalShell>

    <!-- ── Barcode scanner ───────────────────────────────────────────────── -->
    <ModalShell v-if="scannerOpen" title="Scan barcode" @close="closeScanner">
      <p v-if="scannerError" class="warn">{{ scannerError }}</p>
      <video ref="scannerVideo" class="scanner-video" autoplay playsinline muted></video>
      <p class="hint">Point the camera at a barcode.</p>
    </ModalShell>

    <!-- ── Misc item ─────────────────────────────────────────────────────── -->
    <ModalShell v-if="showMisc" title="Misc item" @close="showMisc = false">
      <p class="hint">Sell something that isn't in the catalogue - a commission, old stock. No stock is tracked and rule discounts don't apply.</p>
      <div class="form">
        <input v-model="miscForm.title" type="text" placeholder="Description (e.g. Commission)" />
        <div class="two">
          <label><span>Price ({{ currency }})</span><input v-model="miscForm.price" type="number" min="0" step="0.05" inputmode="decimal" /></label>
          <label><span>Quantity</span><input v-model="miscForm.qty" type="number" min="1" inputmode="numeric" /></label>
        </div>
      </div>
      <template #footer>
        <div class="actions"><button type="button" @click="showMisc = false">Cancel</button><button type="button" class="primary" @click="addMiscItem">Add to cart</button></div>
      </template>
    </ModalShell>

    <!-- ── Cart discount ─────────────────────────────────────────────────── -->
    <ModalShell v-if="showDiscount" title="Cart discount" @close="showDiscount = false">
      <div class="form">
        <div class="seg two">
          <button type="button" :class="{ active: discountForm.type === 'amount' }" @click="discountForm.type = 'amount'">Amount ({{ currency }})</button>
          <button type="button" :class="{ active: discountForm.type === 'percent' }" @click="discountForm.type = 'percent'">Percent (%)</button>
        </div>
        <input v-model="discountForm.value" type="number" min="0" step="0.05" inputmode="decimal" placeholder="Value" />
        <input v-model="discountForm.name" type="text" placeholder="Name (optional)" />
      </div>
      <template #footer>
        <div class="actions between">
          <button v-if="cart.custom" type="button" class="danger" @click="setCustomDiscount(null); showDiscount = false">Remove</button>
          <span class="spacer"></span>
          <button type="button" @click="showDiscount = false">Cancel</button>
          <button type="button" class="primary" @click="applyDiscount">Apply</button>
        </div>
      </template>
    </ModalShell>

    <!-- ── Payment ───────────────────────────────────────────────────────── -->
    <ModalShell v-if="payment.phase !== 'idle'" :title="title" @close="cancelPayment">
      <div class="paybody">
        <p class="amount">{{ money(payment.total) }}</p>

        <template v-if="payment.phase === 'needsLogin'">
          <p class="warn strong">{{ provider.label }} isn't signed in</p>
          <p class="hint">Log in to take this card payment on the reader, or record the card another way.</p>
        </template>

        <template v-else-if="payment.phase === 'terminal'">
          <p class="pulse">Present card to terminal…</p>
          <p class="hint">{{ provider.label }}</p>
        </template>

        <template v-else-if="payment.phase === 'failed'">
          <p class="bad strong">Card payment didn't go through</p>
          <p v-if="payment.error" class="hint">{{ payment.error }}</p>
          <p class="hint">Retry the card, or complete the sale by hand if it was paid another way.</p>
          <button type="button" class="quiet" :disabled="sendingLog" @click="sendLog">{{ sendingLog ? 'Sending…' : logSent ? 'Log sent' : 'Send log to support' }}</button>
        </template>

        <template v-else-if="payment.method === 'cash'">
          <div class="chips">
            <button type="button" class="chip exact" @click="payment.cashReceived = payment.total.toFixed(2)">Exact</button>
            <button v-for="a in cashShortcuts" :key="a" type="button" class="chip" @click="payment.cashReceived = String(a)">{{ a }}</button>
          </div>
          <label class="field"><span>Received</span><input v-model="payment.cashReceived" type="number" inputmode="decimal" class="big" /></label>
          <p>Change: <strong :class="change < -0.001 ? 'bad' : 'good'">{{ change < -0.001 ? '− ' + money(-change) : change < 0.001 ? 'No change' : money(change) }}</strong></p>
        </template>

        <template v-else-if="payment.method === 'split'">
          <div class="two">
            <label class="field"><span>Cash</span><input v-model="payment.splitCash" type="number" inputmode="decimal" /></label>
            <label class="field"><span>Card</span><input v-model="payment.splitCard" type="number" inputmode="decimal" /></label>
          </div>
          <div class="chips">
            <button type="button" class="chip exact" @click="payment.splitCash = Math.max(0, payment.total - (Number(payment.splitCard) || 0)).toFixed(2)">Cash remainder</button>
            <button v-for="a in splitCashShortcuts" :key="a" type="button" class="chip" @click="payment.splitCash = String(a)">{{ a }}</button>
            <button type="button" class="chip cardc" @click="payment.splitCard = Math.max(0, payment.total - (Number(payment.splitCash) || 0)).toFixed(2)">Card remainder</button>
          </div>
          <p>{{ splitState.label }}: <strong :class="splitState.cls">{{ money(splitState.amount) }}</strong></p>
        </template>

        <template v-else>
          <p>Confirm the {{ payment.method === 'card' ? 'card' : payment.method }} payment was completed{{ payment.method === 'card' && !hasTerminal ? ' on the terminal' : '' }}.</p>
        </template>
      </div>
      <template #footer>
        <div class="actions">
          <button type="button" @click="cancelPayment">Cancel</button>
          <button v-if="payment.phase === 'confirm'" type="button" :class="['primary', 'confirm', payment.method]" :disabled="confirmDisabled || cart.busy" @click="confirmPayment">Confirm sale</button>
          <button v-if="payment.phase === 'failed'" type="button" class="primary" @click="payment.phase = 'terminal'; runTerminal()">Retry card</button>
          <button v-if="payment.phase === 'terminal' || payment.phase === 'failed' || payment.phase === 'needsLogin'" type="button" @click="payment.phase = 'confirm'; payment.method = 'card'">{{ payment.phase === 'needsLogin' ? 'Enter card by hand' : 'Complete by hand' }}</button>
          <button v-if="payment.phase === 'needsLogin' && provider.configure" type="button" class="primary" @click="connectReader">Log in</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.pos { display: grid; grid-template-columns: 1fr 20rem; gap: 0; min-height: calc(100vh - 3rem); margin: -1.5rem; }
.floor { display: flex; flex-direction: column; min-width: 0; }
.bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
.event { min-width: 0; display: flex; flex-direction: column; }
.iconbtn { display: inline-flex; align-items: center; min-height: 2rem; padding: .3rem; color: var(--zfy-muted, #5a6472); border-radius: 8px; }
.iconbtn:hover { background: var(--zfy-bg, #f1f4f6); color: var(--zfy-ink, #1a2230); }
.terminal { display: inline-flex; align-items: center; gap: .3rem; min-height: 2rem; padding: .3rem .5rem; }
.dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--zfy-muted, #5a6472); }
.dot.on { background: var(--zfy-accent, #0e7c66); }
.dot.off { background: var(--zfy-danger, #c6512f); }
.dot.checking { animation: pulse 1.4s ease-in-out infinite; }
.event h1 { margin: 0; font-size: 1rem; color: var(--zfy-accent-ink, #0a5a4a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.event h1.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.event small { color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.search-group { display: flex; align-items: center; gap: .2rem; margin-left: auto; max-width: 100%; }
.search { width: 14rem; max-width: 100%; }
.scanner-video { width: 100%; max-height: 60vh; border-radius: 10px; background: #000; object-fit: contain; }
.modes { display: flex; gap: .3rem; }
.pill { min-height: 2rem; padding: .2rem .8rem; border-radius: 999px; font-size: .8rem; }
.pill.active { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); }
.notice { margin: .5rem 1rem 0; padding: .45rem .75rem; border-radius: 8px; font-size: .85rem; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.notice.bad { background: var(--zfy-signal-soft, #f6e5df); color: var(--zfy-danger, #c6512f); }
.last { display: flex; align-items: center; gap: .5rem; padding: .4rem 1rem; font-size: .85rem; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.last .spacer, .actions .spacer { flex: 1; }
.last button { min-height: 1.8rem; padding: .1rem .5rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.last .undo { color: var(--zfy-warning-ink, #8a5a1e); }
.empty, .hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr)); gap: .5rem; padding: .75rem 1rem 1.25rem; align-content: start; }
.grid.inmodal { padding: 0; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); }
.tile { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; min-height: 6rem; padding: .7rem .8rem; text-align: left; border-left: 3px solid var(--zfy-accent, #0e7c66); border-radius: 12px; }
.tile:active { transform: scale(.98); }
.tile.dim { opacity: .55; }
.tile .head { display: flex; align-items: flex-start; gap: .5rem; width: 100%; }
.tile .title { font-weight: 600; font-size: .9rem; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tile small { font-size: .7rem; color: var(--zfy-muted, #5a6472); }
.tile .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; width: 100%; padding-top: .25rem; font-size: .75rem; gap: .5rem; }
.tile .foot strong { font-variant-numeric: tabular-nums; }
.tile.type .foot { color: var(--zfy-muted, #5a6472); }
.count { position: absolute; top: -.4rem; right: -.4rem; min-width: 1.5rem; height: 1.5rem; padding: 0 .4rem; border-radius: 999px; display: grid; place-items: center; font-size: .78rem; font-weight: 700; color: var(--zfy-on-accent, #fff); background: var(--zfy-accent, #0e7c66); }
.bundles { display: flex; gap: .3rem; flex-wrap: wrap; padding-top: .1rem; }
.bundle { font-size: .72rem; font-weight: 700; padding: .15rem .5rem; border-radius: 6px; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); }
.muted { color: var(--zfy-muted, #5a6472); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.bad { color: var(--zfy-danger, #c6512f); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.strong { font-weight: 600; }
.cartbar { display: none; }

.cart { display: flex; flex-direction: column; border-left: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); position: sticky; top: 0; height: calc(100vh - 0px); }
.cart header { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.cart h2 { margin: 0; font-size: 1rem; flex: 1; }
.cart .clear { min-height: 1.8rem; font-size: .8rem; color: var(--zfy-muted, #5a6472); }
.cart .clear.armed { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.cart .close { display: none; }
.lines { flex: 1; min-height: 0; overflow-y: auto; padding: .6rem; }
.lines ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.lines li { background: var(--zfy-bg, #f1f4f6); border-radius: 10px; padding: .55rem .7rem; display: flex; flex-direction: column; gap: .3rem; }
.row { display: flex; justify-content: space-between; align-items: center; gap: .5rem; font-size: .875rem; }
.row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.qty { justify-content: flex-start; gap: .4rem; }
.row.qty button { min-height: 1.9rem; min-width: 1.9rem; padding: 0; font-weight: 700; }
.row.qty span { min-width: 1.5rem; text-align: center; font-variant-numeric: tabular-nums; }
.row.qty small { margin-left: auto; color: var(--zfy-muted, #5a6472); font-size: .72rem; }
.cart footer { border-top: 1px solid var(--zfy-line, #d6dde4); padding: .7rem; display: flex; flex-direction: column; gap: .5rem; }
.sums { display: flex; flex-direction: column; gap: .15rem; font-variant-numeric: tabular-nums; }
.row.total { font-size: 1.05rem; font-weight: 700; }
.row.small { font-size: .78rem; }
.tools { display: flex; gap: .4rem; }
.tools button { flex: 1; min-height: 2.1rem; font-size: .8rem; padding: .2rem .4rem; }
.pay { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .4rem; }
.pay .custom { grid-column: 1 / -1; background: var(--zfy-ink, #1a2230); }
.pay button, .confirm { min-height: 2.8rem; font-weight: 700; color: #fff; border: 0; }
.pay .cash, .confirm.cash { background: #0e7c66; }
.pay .card, .confirm.card { background: #2f6fb8; }
.pay .split, .confirm.split { background: #b8742f; }
.pay button:hover:not(:disabled), .confirm:hover:not(:disabled) { filter: brightness(1.08); }

.form { display: flex; flex-direction: column; gap: .6rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.seg.two { display: flex; }
.seg.two button { flex: 1; min-height: 2.5rem; }
.field { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; text-align: left; }
.field .big { font-size: 1.2rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
.actions.between { justify-content: flex-start; }
.paybody { display: flex; flex-direction: column; gap: .8rem; text-align: center; }
.paybody p { margin: 0; }
.amount { font-size: 2rem; font-weight: 800; letter-spacing: -.01em; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.chips { display: flex; justify-content: center; gap: .4rem; flex-wrap: wrap; }
.chip { min-height: 2.2rem; padding: .2rem .8rem; font-weight: 600; }
.chip.exact { color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); }
.chip.cardc { color: #2f6fb8; border-color: #2f6fb8; }

@media (max-width: 860px) {
  .pos { grid-template-columns: 1fr; margin: -1rem; }
  .cart { display: none; }
  .cart.sheet { display: flex; position: fixed; inset: 0; z-index: 25; height: auto; border-left: 0; }
  .cart.sheet .close { display: inline-flex; }
  /* The floor fills the viewport so the cart button sits at the bottom even
     with a short list, and stays there while a long one scrolls. */
  .floor { display: flex; flex-direction: column; min-height: calc(100dvh - 3.1rem - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--zfy-bottom-nav, 0px)); }
  .grid { flex: 1; }
  /* Sticks just above the shell's tab bar, whose height the shell publishes. */
  .cartbar { display: flex; justify-content: space-between; margin: auto 1rem .75rem; min-height: 3rem; font-size: 1rem; position: sticky; bottom: calc(var(--zfy-bottom-nav, 0px) + .5rem); z-index: 3; box-shadow: 0 8px 24px -10px var(--zfy-shadow, rgba(20,26,34,.4)); }
  .cartbar span { display: inline-flex; align-items: center; gap: .4rem; }
  .search-group { margin-left: 0; width: 100%; order: 3; }
  .search { flex: 1; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .6rem .75rem 1rem; }
  .tile { min-height: 5.5rem; padding: .55rem .6rem; }
  .grid.inmodal { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
