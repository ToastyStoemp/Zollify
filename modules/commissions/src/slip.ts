import { qrPngBase64 } from '@zollify/ui';
import { COMMISSION_STATUS_LABEL } from '@zollify/shared';
import type { CommissionView } from './api';

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A small slip to hand the customer: what the piece is, the due date and a QR
 * code for the tracking page. Contact details and notes are left off - it
 * leaves the shop in the customer's hand. Opened as a document so the browser
 * prints it (or the app's viewer shares it).
 */
export async function slipHtml(c: CommissionView, shop: string): Promise<string> {
  const qr = await qrPngBase64(c.publicUrl, { paperDots: 300, codeDots: 300 });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Commission slip</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;color:#000;background:#fff}
.slip{width:300px;margin:0 auto;text-align:center}
h1{font-size:18px;margin:0 0 4px}
.shop{font-size:12px;letter-spacing:.12em;text-transform:uppercase}
p{margin:4px 0;font-size:14px;overflow-wrap:anywhere}
img{width:300px;height:300px;display:block;margin:8px auto}
.url{font-size:10px}
@media print{body{padding:0}}
</style></head>
<body><div class="slip">
<div class="shop">${h(shop)}</div>
<h1>${h(c.title)}</h1>
<p>${h(COMMISSION_STATUS_LABEL[c.status])}${c.dueDate ? ` &middot; due ${h(c.dueDate)}` : ''}</p>
<img src="data:image/png;base64,${qr}" alt="QR code to follow this commission" />
<p>Scan to follow progress</p>
<p class="url">${h(c.publicUrl)}</p>
</div></body></html>`;
}
