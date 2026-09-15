import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { monthKey, type Cluster, type Txn } from './types';
import { sdk } from '../runtime';

/**
 * The revenue and fees reports, as PDFs: one per cluster, and one per month
 * across every cluster in it. Attached to the Lexware voucher as evidence and
 * downloadable on their own. Ported from ZollTax; the layout is the one the
 * bookkeeper already knows.
 */

type RGB = [number, number, number];
const C_DARK: RGB = [28, 28, 33];
const C_WHITE: RGB = [255, 255, 255];
const C_BLUE: RGB = [50, 90, 190];
const C_RULE: RGB = [215, 215, 222];
const C_MUTED: RGB = [130, 130, 145];
const C_ALT: RGB = [249, 249, 251];
const C_CASH: RGB = [120, 80, 200];
const MW = 210;
const MG = 18;
const CW = MW - MG * 2;

const n2 = (n: number): string => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (ms: number): string => {
  const d = new Date(ms);
  return d.toLocaleDateString('nl-BE', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
};
const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');
const range = (c: Cluster): string => fmtDate(c.start) + (fmtDate(c.start) !== fmtDate(c.end) ? ' - ' + fmtDate(c.end) : '');
const genOn = (): string => new Date().toLocaleDateString('nl-BE', { day: '2-digit', month: 'long', year: 'numeric' });

function header(doc: jsPDF, accent: RGB, docId: string, title: string, sub: string, sub2: string): void {
  doc.setFillColor(...C_DARK);
  doc.rect(0, 0, MW, 34, 'F');
  doc.setFillColor(...accent);
  doc.rect(0, 0, 4, 34, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(180, 180, 200);
  doc.text(docId, MW - MG, 9, { align: 'right' });
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...C_WHITE);
  doc.text(title, MG, 14);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(175, 175, 195);
  doc.text(sub, MG, 21);
  if (sub2) {
    doc.setFontSize(7.5).setTextColor(150, 150, 170);
    doc.text(sub2, MG, 26.5);
  }
  doc.setFontSize(7.5).setTextColor(130, 130, 155);
  doc.text('Generated: ' + genOn(), MG, 31);
}

function box(doc: jsPDF, x: number, y: number, w: number, label: string, value: string, sub: string, col: RGB): void {
  doc.setDrawColor(...C_RULE).setFillColor(250, 250, 252);
  doc.roundedRect(x, y, w, 24, 2, 2, 'FD');
  doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(...C_MUTED);
  doc.text(label.toUpperCase(), x + 4, y + 7);
  doc.setFont('helvetica', 'bold').setFontSize(11.5).setTextColor(...col);
  doc.text(value, x + 4, y + 16);
  if (sub) {
    doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(...C_MUTED);
    doc.text(sub, x + 4, y + 21);
  }
}

function sectionTitle(doc: jsPDF, y: number, text: string): number {
  doc.setFont('helvetica', 'bold').setFontSize(7.5).setTextColor(...C_MUTED);
  doc.text(text, MG, y);
  doc.setDrawColor(...C_RULE).line(MG, y + 2, MW - MG, y + 2);
  return y + 8;
}

function totalBar(doc: jsPDF, accent: RGB, label: string, value: string): void {
  const fy = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 200) + 5;
  if (fy >= 268) return;
  doc.setFillColor(...C_DARK).rect(MG, fy, CW, 11, 'F');
  doc.setFillColor(...accent).rect(MG, fy, 3, 11, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...C_WHITE);
  doc.text(label, MG + 7, fy + 7.5);
  doc.text(value, MW - MG - 3, fy + 7.5, { align: 'right' });
}

function footer(doc: jsPDF, left: string): () => void {
  return () => {
    const pg = doc.getCurrentPageInfo().pageNumber;
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...C_MUTED);
    doc.setDrawColor(...C_RULE).line(MG, 286, MW - MG, 286);
    doc.text(left, MG, 290);
    doc.text('p. ' + pg, MW - MG, 290, { align: 'right' });
  };
}

export type ReportMode = 'payments' | 'fees';

/** A cluster's report. Returns the PDF bytes and its file name. */
export function clusterPdf(c: Cluster, mode: ReportMode): { bytes: Uint8Array; filename: string } {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const isPay = mode === 'payments';
  const accent: RGB = isPay ? [34, 139, 87] : [185, 55, 53];
  const txns: Txn[] = [...(isPay ? c.payments : c.fees)].sort((a, b) => a.at - b.at);
  const docId = `${c.clusterID}_${isPay ? 'P' : 'F'}`;
  const dateRange = range(c);
  const displayName = c.customName || dateRange;

  header(doc, accent, docId, isPay ? 'PAYMENTS REPORT' : 'FEES REPORT', `${displayName} | ${c.device}`, c.customName ? dateRange : '');

  const y = 42;
  const bW = (CW - 8) / 3;
  const cash = c.cashAmount || 0;
  const grandTotal = c.totalPay + cash;
  if (isPay) {
    const avg = txns.length ? c.totalPay / txns.length : 0;
    const hi = txns.length ? Math.max(...txns.map((t) => t.amount)) : 0;
    if (cash) {
      box(doc, MG, y, bW, 'Card Revenue', 'EUR ' + n2(c.totalPay), `${txns.length} transactions`, accent);
      box(doc, MG + bW + 4, y, bW, 'Cash Sales', 'EUR ' + n2(cash), c.cashNote || 'manual entry', C_CASH);
      box(doc, MG + (bW + 4) * 2, y, bW, 'Total Revenue', 'EUR ' + n2(grandTotal), 'card + cash', accent);
    } else {
      box(doc, MG, y, bW, 'Total Revenue', 'EUR ' + n2(c.totalPay), `${txns.length} transactions`, accent);
      box(doc, MG + bW + 4, y, bW, 'Average', 'EUR ' + n2(avg), '', C_DARK);
      box(doc, MG + (bW + 4) * 2, y, bW, 'Highest', 'EUR ' + n2(hi), '', C_DARK);
    }
  } else {
    const rate = grandTotal > 0 ? ((c.totalFee / grandTotal) * 100).toFixed(2) + '%' : '0.00%';
    box(doc, MG, y, bW, 'Total Fees', 'EUR ' + n2(c.totalFee), `${txns.length} entries`, accent);
    box(doc, MG + bW + 4, y, bW, 'Fee Rate', rate, 'of total revenue', C_DARK);
    box(doc, MG + (bW + 4) * 2, y, bW, 'Net Revenue', 'EUR ' + n2(grandTotal - c.totalFee), 'after fees', C_BLUE);
  }

  const tableY = sectionTitle(doc, y + 32, 'TRANSACTION DETAIL');
  const columns = isPay
    ? [{ header: 'Date & Time', dataKey: 'dt' }, { header: 'Card', dataKey: 'card' }, { header: 'Reference', dataKey: 'ref' }, { header: 'Amount (EUR)', dataKey: 'amt' }]
    : [{ header: 'Date & Time', dataKey: 'dt' }, { header: 'Reference', dataKey: 'ref' }, { header: 'Description', dataKey: 'desc' }, { header: 'Fee (EUR)', dataKey: 'amt' }];
  const body = txns.map((t) => ({ dt: fmtDateTime(t.at), card: t.card || '-', ref: t.ref ? t.ref.slice(0, 22) : '-', desc: t.desc ? t.desc.slice(0, 50) : '-', amt: n2(Math.abs(t.amount)) }));
  if (isPay && cash) body.push({ dt: c.cashNote ? `Cash - ${c.cashNote}` : 'Cash sales', card: 'Cash', ref: 'Manual entry', desc: '-', amt: n2(cash) });

  autoTable(doc, {
    startY: tableY,
    columns,
    body,
    margin: { left: MG, right: MG },
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 }, textColor: C_DARK, lineColor: C_RULE, lineWidth: 0.18, overflow: 'ellipsize' },
    headStyles: { fillColor: C_DARK, textColor: C_WHITE, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: C_ALT },
    columnStyles: { amt: { halign: 'right', fontStyle: 'bold', textColor: accent } },
    didParseCell: (data) => {
      if (isPay && cash && data.row.index === body.length - 1) {
        data.cell.styles.fillColor = [245, 240, 255];
        data.cell.styles.textColor = [100, 60, 180];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: footer(doc, `${docId}  |  ${c.device}  |  ${dateRange}`),
  });

  totalBar(doc, accent, isPay ? 'TOTAL PAYMENTS' : 'TOTAL FEES', 'EUR ' + (isPay ? n2(grandTotal) : n2(c.totalFee)));
  return { bytes: new Uint8Array(doc.output('arraybuffer')), filename: `${safe(docId)}.pdf` };
}

/** A month's report across its clusters. */
export function monthPdf(key: string, all: Cluster[], mode: ReportMode): { bytes: Uint8Array; filename: string } | null {
  const clusters = all.filter((c) => monthKey(c.start) === key);
  if (!clusters.length) return null;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const isPay = mode === 'payments';
  const accent: RGB = isPay ? [34, 139, 87] : [185, 55, 53];
  const docId = `PN_${key}_${isPay ? 'P' : 'F'}`;
  const [yr, mo] = key.split('_') as [string, string];
  const monthLabel = new Date(+yr, +mo - 1, 1).toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' }).toUpperCase();

  const totalPay = clusters.reduce((s, c) => s + c.totalPay, 0);
  const totalCash = clusters.reduce((s, c) => s + (c.cashAmount || 0), 0);
  const totalFee = clusters.reduce((s, c) => s + c.totalFee, 0);
  const allTxns = clusters.flatMap((c) => (isPay ? c.payments : c.fees)).sort((a, b) => a.at - b.at);

  header(doc, accent, docId, `${isPay ? 'PAYMENTS' : 'FEES'} - ${monthLabel}`, `${clusters.length} cluster${clusters.length !== 1 ? 's' : ''}  |  ${allTxns.length} transactions`, '');

  let y = 42;
  const bW = (CW - 8) / 3;
  if (isPay) {
    const avg = allTxns.length ? totalPay / allTxns.length : 0;
    const hi = allTxns.length ? Math.max(...allTxns.map((t) => t.amount)) : 0;
    if (totalCash) {
      box(doc, MG, y, bW, 'Card Revenue', 'EUR ' + n2(totalPay), `${allTxns.length} transactions`, accent);
      box(doc, MG + bW + 4, y, bW, 'Cash Sales', 'EUR ' + n2(totalCash), 'manual entries', C_CASH);
      box(doc, MG + (bW + 4) * 2, y, bW, 'Total Revenue', 'EUR ' + n2(totalPay + totalCash), 'card + cash', accent);
    } else {
      box(doc, MG, y, bW, 'Total Revenue', 'EUR ' + n2(totalPay), `${allTxns.length} transactions`, accent);
      box(doc, MG + bW + 4, y, bW, 'Average', 'EUR ' + n2(avg), 'per transaction', C_DARK);
      box(doc, MG + (bW + 4) * 2, y, bW, 'Highest', 'EUR ' + n2(hi), 'single transaction', C_DARK);
    }
  } else {
    const grand = totalPay + totalCash;
    const rate = grand > 0 ? ((totalFee / grand) * 100).toFixed(2) + '%' : '0.00%';
    box(doc, MG, y, bW, 'Total Fees', 'EUR ' + n2(totalFee), `${allTxns.length} entries`, accent);
    box(doc, MG + bW + 4, y, bW, 'Fee Rate', rate, 'of total revenue', C_DARK);
    box(doc, MG + (bW + 4) * 2, y, bW, 'Net Revenue', 'EUR ' + n2(grand - totalFee), 'after fees', C_BLUE);
  }
  y = sectionTitle(doc, y + 32, 'CLUSTER BREAKDOWN') - 1;

  for (const c of [...clusters].sort((a, b) => a.start - b.start)) {
    const cTxns = isPay ? c.payments : c.fees;
    const cTotal = isPay ? c.totalPay : c.totalFee;
    const dr = c.isOnlineCluster ? 'Online orders' : range(c);
    const label = c.customName ? `${c.clusterID}  ${c.customName}` : c.clusterID;
    doc.setFillColor(246, 246, 250).rect(MG, y, CW, 13, 'F');
    doc.setDrawColor(...C_RULE).rect(MG, y, CW, 13, 'D');
    doc.setFont('helvetica', 'bold').setFontSize(7.5).setTextColor(...C_DARK);
    doc.text(label, MG + 4, y + 5.5);
    doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(...C_MUTED);
    doc.text(dr + (c.isOnlineCluster ? '' : '  |  ' + c.device), MG + 4, y + 10.5);
    doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...accent);
    doc.text(`EUR ${n2(cTotal)}  (${cTxns.length})`, MW - MG - 3, y + 8, { align: 'right' });
    y += 13;
  }
  y = sectionTitle(doc, y + 6, 'FULL TRANSACTION DETAIL');

  const clusterOf = new Map<string, Cluster>();
  for (const c of clusters) for (const t of isPay ? c.payments : c.fees) clusterOf.set(t.id, c);
  const columns = isPay
    ? [{ header: 'Date & Time', dataKey: 'dt' }, { header: 'Cluster', dataKey: 'cid' }, { header: 'Device', dataKey: 'dev' }, { header: 'Card', dataKey: 'card' }, { header: 'Amount (EUR)', dataKey: 'amt' }]
    : [{ header: 'Date & Time', dataKey: 'dt' }, { header: 'Cluster', dataKey: 'cid' }, { header: 'Reference', dataKey: 'ref' }, { header: 'Fee (EUR)', dataKey: 'amt' }];
  const body = allTxns.map((t) => {
    const cc = clusterOf.get(t.id);
    return { dt: fmtDateTime(t.at), cid: cc?.clusterID ?? '-', dev: cc ? cc.device.split(' + ')[0]! : '-', card: t.card || '-', ref: t.ref ? t.ref.slice(0, 18) : '-', amt: n2(Math.abs(t.amount)) };
  });
  const cashRows = new Set<number>();
  if (isPay) {
    for (const c of [...clusters].sort((a, b) => a.start - b.start)) {
      if (!c.cashAmount) continue;
      body.push({ dt: c.cashNote ? `Cash - ${c.cashNote}` : 'Cash sales', cid: c.clusterID, dev: 'Cash', card: 'Cash', ref: 'Manual entry', amt: n2(c.cashAmount) });
      cashRows.add(body.length - 1);
    }
  }

  autoTable(doc, {
    startY: y,
    columns,
    body,
    margin: { left: MG, right: MG },
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 3, bottom: 3, left: 3, right: 3 }, textColor: C_DARK, lineColor: C_RULE, lineWidth: 0.15, overflow: 'ellipsize' },
    headStyles: { fillColor: C_DARK, textColor: C_WHITE, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: C_ALT },
    columnStyles: { amt: { halign: 'right', fontStyle: 'bold', textColor: accent } },
    didParseCell: (data) => {
      if (cashRows.has(data.row.index)) {
        data.cell.styles.fillColor = [245, 240, 255];
        data.cell.styles.textColor = [100, 60, 180];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: footer(doc, `${docId}  |  ${monthLabel}`),
  });

  totalBar(doc, accent, `${isPay ? 'TOTAL PAYMENTS' : 'TOTAL FEES'} FOR ${monthLabel}`, 'EUR ' + (isPay ? n2(totalPay + totalCash) : n2(totalFee)));
  return { bytes: new Uint8Array(doc.output('arraybuffer')), filename: `${safe(docId)}.pdf` };
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function download(bytes: Uint8Array, filename: string): void {
  void sdk().ui.saveFile(filename, new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }), 'application/pdf');
}
