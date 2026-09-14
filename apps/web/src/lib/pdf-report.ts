import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { SalesEvent, Transaction } from '@zollify/shared';

/** End-of-event sales report, ported from ZollTool: summary, payment split, best sellers, daily revenue, full sales list. */
export function buildSalesReportPdf(event: SalesEvent, transactions: Transaction[]): { bytes: ArrayBuffer; filename: string } {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const cur = event.currency;
  const money = (n: number) => `${cur} ${n.toFixed(2)}`;

  // Everything in this report is shown in the base/tracking currency, even for
  // sales charged in a converted local currency (SalesEvent.localCurrency) —
  // it's the accounting-oriented document, so figures without a precomputed
  // base value (payment legs, discounts) are converted back via the rate
  // snapshotted on the transaction at checkout time.
  const toBase = (amount: number, tx: Transaction): number => (tx.exchangeRate ? amount / tx.exchangeRate : amount);

  const active = transactions.filter((t) => !t.revertedAt);
  const reverted = transactions.length - active.length;
  const revenue = active.reduce((s, t) => s + (t.baseTotal ?? t.total), 0);
  const items = active.reduce((s, t) => s + t.items.reduce((si, i) => si + i.qty, 0), 0);
  const legTotal = (kind: 'cash' | 'card') =>
    active.reduce(
      (s, t) => s + t.payments.filter((p) => p.kind === kind).reduce((sp, p) => sp + toBase(p.amount, t), 0),
      0,
    );
  const discountTotal = active.reduce(
    (s, t) => s + t.discounts.reduce((sd, d) => sd + toBase(d.amount, t), 0),
    0,
  );

  // ── Header ────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold').setFontSize(18);
  doc.text(event.name, margin, 20);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(110);
  const dates = [event.dateStart, event.dateEnd].filter(Boolean).join(' – ');
  const place = [event.venue?.city, event.venue?.country].filter(Boolean).join(', ');
  doc.text(['Sales report', dates, place].filter(Boolean).join('  ·  '), margin, 26);
  doc.text(`Generated ${new Date().toLocaleString()}`, pageW - margin, 26, { align: 'right' });
  doc.setDrawColor(200).line(margin, 29, pageW - margin, 29);
  doc.setTextColor(0);

  // ── Summary tiles ─────────────────────────────────────────────────────────
  const tiles: [string, string][] = [
    ['Revenue', money(revenue)],
    ['Sales', `${active.length}`],
    ['Items sold', `${items}`],
    ['Cash', money(legTotal('cash'))],
    ['Card', money(legTotal('card'))],
    ['Discounts given', money(discountTotal)],
  ];
  let y = 34;
  const tileW = (pageW - margin * 2 - 5 * 3) / 3;
  tiles.forEach(([label, value], i) => {
    const x = margin + (i % 3) * (tileW + 3);
    const ty = y + Math.floor(i / 3) * 16;
    doc.setFillColor(244, 246, 250).roundedRect(x, ty, tileW, 14, 2, 2, 'F');
    doc.setFontSize(8).setTextColor(110).text(label, x + 3, ty + 5);
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(0).text(value, x + 3, ty + 11);
    doc.setFont('helvetica', 'normal');
  });
  y += 16 * Math.ceil(tiles.length / 3) + 4;
  if (reverted > 0) {
    doc.setFontSize(8).setTextColor(160).text(`${reverted} reverted sale(s) excluded from all figures.`, margin, y);
    doc.setTextColor(0);
    y += 5;
  }

  // ── Best sellers ──────────────────────────────────────────────────────────
  const sellerMap = new Map<string, { label: string; qty: number; value: number }>();
  for (const tx of active) {
    for (const it of tx.items) {
      const key = `${it.pid}:${it.vid ?? ''}`;
      const label = it.variantLabel ? `${it.title} · ${it.variantLabel}` : it.title;
      const curEntry = sellerMap.get(key) ?? { label, qty: 0, value: 0 };
      curEntry.qty += it.qty;
      curEntry.value += it.baseLineTotal ?? it.lineTotal;
      sellerMap.set(key, curEntry);
    }
  }
  const sellers = [...sellerMap.values()].sort((a, b) => b.qty - a.qty);
  if (sellers.length) {
    doc.setFont('helvetica', 'bold').setFontSize(12).text('Products sold', margin, y + 6);
    autoTable(doc, {
      startY: y + 9,
      margin: { left: margin, right: margin },
      head: [['#', 'Product', 'Qty', 'Revenue']],
      body: sellers.map((s, i) => [String(i + 1), s.label, String(s.qty), money(s.value)]),
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 0: { cellWidth: 8 }, 2: { cellWidth: 14, halign: 'right' }, 3: { cellWidth: 28, halign: 'right' } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  }

  // ── Daily revenue bars ────────────────────────────────────────────────────
  const dayMap = new Map<string, number>();
  for (const tx of active) {
    const day = new Date(tx.timestamp).toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + (tx.baseTotal ?? tx.total));
  }
  const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (days.length > 1) {
    const blockH = 8 + days.length * 6;
    if (y + blockH > doc.internal.pageSize.getHeight() - 15) {
      doc.addPage();
      y = 15;
    }
    doc.setFont('helvetica', 'bold').setFontSize(12).text('Revenue per day', margin, y + 6);
    y += 10;
    const max = Math.max(...days.map(([, v]) => v));
    const barMax = pageW - margin * 2 - 24 - 30;
    for (const [day, value] of days) {
      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110).text(day.slice(5), margin, y + 3);
      doc.setFillColor(16, 185, 129).roundedRect(margin + 14, y, Math.max(1, (value / max) * barMax), 4, 1, 1, 'F');
      doc.setTextColor(0).text(money(value), pageW - margin, y + 3, { align: 'right' });
      y += 6;
    }
  }

  // ── Full sales list ───────────────────────────────────────────────────────
  if (transactions.length) {
    doc.setTextColor(0);
    autoTable(doc, {
      startY: y + 8,
      margin: { left: margin, right: margin },
      head: [['Time', 'Method', 'Items', 'Total', '']],
      body: [...transactions]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((tx) => [
          new Date(tx.timestamp).toLocaleString(undefined, {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
          tx.method,
          tx.items
            .map((i) => `${i.qty}× ${i.variantLabel ? `${i.title} · ${i.variantLabel}` : i.title}`)
            .join(', '),
          money(tx.baseTotal ?? tx.total),
          tx.revertedAt ? 'REVERTED' : '',
        ]),
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 14 },
        3: { cellWidth: 24, halign: 'right' },
        4: { cellWidth: 20, textColor: [220, 38, 38] },
      },
      didParseCell: (hook) => {
        if (hook.section === 'body' && hook.row.raw && (hook.row.raw as string[])[4] === 'REVERTED') {
          hook.cell.styles.textColor = [150, 150, 150];
        }
      },
    });
  }

  // ── Footer page numbers ───────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8).setTextColor(160);
    doc.text(`${event.name} — page ${p}/${pages}`, pageW / 2, doc.internal.pageSize.getHeight() - 7, {
      align: 'center',
    });
  }

  return { bytes: doc.output('arraybuffer'), filename: `${event.name.replace(/[^\w-]+/g, '_')}_report.pdf` };
}
