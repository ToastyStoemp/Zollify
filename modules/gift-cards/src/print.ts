import { fmtPrice, formatGiftCardCode, type GiftCard } from '@zollify/shared';
import { sdk } from './runtime';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A printable gift card: the shop, the amount, the code large enough to
 * read and type, and when it stops being valid. Plain HTML the browser
 * prints - a card-sized slip for the customer when there is no label
 * printer, or something nicer than a label when there is.
 */
export function cardHtml(c: Pick<GiftCard, 'code' | 'value' | 'currency' | 'expiresAt' | 'note'>, shop: string): string {
  const until = c.expiresAt ? `Valid until ${new Date(c.expiresAt).toLocaleDateString()}` : 'Does not expire';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gift card</title>
<style>
  @page { size: A6 landscape; margin: 8mm; }
  body { font-family: system-ui, sans-serif; color: #111; margin: 0; }
  .card { border: 1px solid #999; border-radius: 10px; padding: 10mm; width: 128mm; box-sizing: border-box; display: flex; flex-direction: column; gap: 6mm; }
  .shop { font-size: 11pt; letter-spacing: .08em; text-transform: uppercase; color: #555; }
  h1 { margin: 0; font-size: 22pt; }
  .amount { font-size: 28pt; font-weight: 700; }
  .code { font-family: ui-monospace, Menlo, monospace; font-size: 18pt; letter-spacing: .08em; }
  .small { font-size: 9pt; color: #555; }
  @media screen { body { padding: 10mm; background: #eee; } .card { background: #fff; } }
</style></head><body><div class="card">
  <div class="shop">${esc(shop)}</div>
  <h1>Gift card</h1>
  <div class="amount">${esc(fmtPrice(c.value, c.currency))}</div>
  <div class="code">${esc(formatGiftCardCode(c.code))}</div>
  <div class="small">${esc(until)}. Show this code at the till; it can be spent in parts.</div>
</div><script>window.addEventListener('load',function(){setTimeout(function(){window.print()},150)})</script></body></html>`;
}

export function printCard(c: Pick<GiftCard, 'code' | 'value' | 'currency' | 'expiresAt' | 'note'>, shop: string): Promise<boolean> {
  return sdk().ui.openDocument(`gift-card-${formatGiftCardCode(c.code).slice(-4)}.html`, cardHtml(c, shop), 'text/html');
}
