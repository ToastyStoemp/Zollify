/**
 * IAA-Plus filing sheet.
 *
 * IAA-Plus (ATLAS-Ausfuhr Internet) is German customs' free web form for
 * occasional exporters, at zoll.de. This module has never filed through it -
 * no verified screen-by-screen mapping exists. What IS stable and public is
 * the box-numbering IAA-Plus is built on: the standard EU export declaration
 * (Einheitspapier / SAD) fields, unchanged across every ATLAS front end.
 *
 * `buildIaaPlusSheetData` produces the box-by-box values once; the app
 * renders it inline on the documents page, and `buildIaaPlusSheetHtml` turns
 * the same data into a printable copy. Match each box number here to the one
 * shown next to the field on the live form as you go - the box numbers are
 * standard, the on-screen wording and layout may vary.
 */
import { calcDeProduct, esc, fmtWeightKg } from './calc';
import type { CustomsDeState } from './model';

export interface FilingBox {
  no: string;
  label: string;
  lines: string[];
}

export interface FilingGoodsRow {
  no: number;
  title: string;
  tariffNo: string;
  origin: string;
  grossKg: number;
  netKg: number;
  value: number | null;
}

export interface FilingSheetData {
  event: string;
  today: string;
  currency: string;
  boxes: FilingBox[];
  goods: FilingGoodsRow[];
  totals: { weightKg: number; value: number };
  procedureNote: string;
  massNote: string;
}

export function buildIaaPlusSheetData(state: CustomsDeState, now: Date = new Date()): FilingSheetData {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const products = state.products.filter((p) => !p.unlisted && p.amount > 0);

  let totWeightKg = 0,
    totValue = 0;
  const goods: FilingGoodsRow[] = products.map((p, i) => {
    const c = calcDeProduct(p);
    totWeightKg += c.totalWeightKg;
    totValue += c.totalValue ?? 0;
    return {
      no: i + 1,
      title: p.title || '',
      tariffNo: p.tariffNo || '-',
      origin: (p.originCountry || d.countryOfOrigin || '').toUpperCase(),
      grossKg: c.totalWeightKg,
      netKg: c.totalWeightKg,
      value: c.totalValue,
    };
  });

  const exporterLines = [d.companyName || d.fullName || '', d.street, d.postCodeCity, d.countryOfOrigin, m.eori ? `EORI: ${m.eori}` : ''].filter(Boolean);
  // Own booth selling at the event - consignee is "self, care of the event" unless a separate importer is known.
  const consigneeLines = [
    d.companyName || d.fullName || '',
    'c/o ' + (m.event || ''),
    [m.eventLocation, m.destinationCountry].filter(Boolean).join(', '),
  ].filter(Boolean);

  const boxes: FilingBox[] = [
    { no: '1', label: 'Declaration type', lines: ['EX A - export'] },
    { no: '2', label: 'Exporter', lines: exporterLines },
    { no: '5', label: 'Total items', lines: [String(products.length)] },
    { no: '6', label: 'Total packages', lines: [String(m.totalPackages || 1)] },
    { no: '7', label: 'Reference number', lines: m.referenceNumber ? [m.referenceNumber] : [] },
    { no: '8', label: 'Consignee', lines: consigneeLines },
    { no: '9 / 14', label: 'Financially responsible party / Declarant', lines: ['Same as box 2 - filing on own account, no separate representative'] },
    { no: '15a', label: 'Country of export', lines: ['DE'] },
    { no: '17a', label: 'Country of destination', lines: m.destinationCountry ? [m.destinationCountry.toUpperCase()] : [] },
    { no: '18', label: 'Identity of transport at departure', lines: [m.transportMode, m.vehicleReg].filter(Boolean) },
    { no: '21', label: 'Nationality of active means of transport', lines: m.transportNationality ? [m.transportNationality.toUpperCase()] : [] },
    { no: '22', label: 'Currency & total invoiced amount', lines: [`${cur} ${Math.floor(totValue)}`] },
    { no: '25', label: 'Mode of transport at the border', lines: m.transportMode ? [m.transportMode] : [] },
    { no: '29', label: 'Office of exit', lines: [m.exitOffice || m.precheckOffice].filter(Boolean) },
    {
      no: '44',
      label: 'Additional information',
      lines: [`Temporary export of exhibition/sale goods for ${m.event || 'the event'}, ${[m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' – ')}. Unsold goods to be re-imported.`],
    },
    { no: '54', label: 'Place, date, declarant', lines: [[m.placeOfDeclaration, today, d.fullName || d.companyName || ''].filter(Boolean).join(' · ')] },
  ];

  return {
    event: m.event || '',
    today,
    currency: cur,
    boxes,
    goods,
    totals: { weightKg: totWeightKg, value: totValue },
    procedureNote:
      'Box 37 (Procedure/CPC) is deliberately left off this sheet - ask your Hauptzollamt or broker for the correct procedure code for a temporary export intended to return. Guessing this wrong is the kind of mistake that gets a declaration rejected or worse.',
    massNote:
      'Net and gross mass are shown equal because this catalogue does not track packaging weight separately - adjust box 38 downward on the live form if your packaging adds meaningful weight. Box 33 commodity codes are whatever you entered under Products → Customs details; this module does not look them up or verify them.',
  };
}

export function buildIaaPlusSheetHtml(state: CustomsDeState, now: Date = new Date()): string {
  const data = buildIaaPlusSheetData(state, now);

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #000; padding: 15mm; }
  .watermark { text-align: center; font-size: 8pt; color: #a30; font-weight: bold; letter-spacing: 1px;
               border: 1.5px solid #a30; padding: 4px 10px; display: inline-block; margin-bottom: 6mm; text-transform: uppercase; }
  .doc-title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin-bottom: 1mm; }
  .doc-subtitle { font-size: 8pt; color: #555; margin-bottom: 6mm; line-height: 1.5; }
  table.boxes { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-bottom: 6mm; }
  table.boxes td { border: 1px solid #ccc; padding: 5px 7px; vertical-align: top; }
  table.boxes td.no { width: 2.4em; font-weight: bold; color: #666; background: #f3f3f3; text-align: center; }
  table.boxes td.label { width: 11em; color: #555; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6mm; }
  table.goods th { background: #222; color: #fff; padding: 4px 6px; text-align: left; font-size: 7.5pt; white-space: nowrap; }
  table.goods th.r { text-align: right; }
  table.goods td { border-bottom: 1px solid #ddd; padding: 4px 6px; }
  table.goods tr:nth-child(even) td { background: #f8f8f8; }
  table.goods tfoot td { background: #eee; font-weight: bold; border-top: 2px solid #555; padding: 5px 6px; }
  .r { text-align: right; }
  .notice { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; line-height: 1.6; }
  @media print { body { padding: 0; } @page { size: A4 portrait; margin: 15mm; } }`;

  const box = (b: FilingBox): string =>
    `<tr><td class="no">${esc(b.no)}</td><td class="label">${esc(b.label)}</td><td>${b.lines.length ? b.lines.map(esc).join('<br>') : '<em style="color:#c00">missing</em>'}</td></tr>`;

  const rows = data.goods
    .map(
      (g) => `<tr>
      <td class="r">${g.no}</td>
      <td>${esc(g.title)}</td>
      <td>${esc(g.tariffNo)}</td>
      <td>${esc(g.origin)}</td>
      <td class="r">${fmtWeightKg(g.grossKg)}</td>
      <td class="r">${fmtWeightKg(g.netKg)}</td>
      <td class="r">${g.value != null ? g.value : '-'}</td>
    </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>IAA-Plus filing sheet - ${esc(data.event)}</title>
<style>${CSS}</style></head><body>
<div class="watermark">Filing reference &mdash; not verified against the live IAA-Plus screen</div>
<div class="doc-title">IAA-Plus filing sheet</div>
<div class="doc-subtitle">
  Box numbers match the standard EU export declaration (SAD) fields IAA-Plus is built on. Check the box number
  shown on each field of the live form as you type - the numbering is standard, the screen layout may differ.
</div>

<table class="boxes">
  ${data.boxes
    .slice(0, data.boxes.length - 1)
    .map(box)
    .join('')}
</table>

<table class="goods">
  <thead><tr>
    <th class="r">32 · Item</th>
    <th>31 · Description</th>
    <th>33 · Commodity code</th>
    <th>34a · Origin</th>
    <th class="r">35 · Gross mass</th>
    <th class="r">38 · Net mass</th>
    <th class="r">46 · Value (${esc(data.currency)})</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:8px;color:#888">Nothing claimed for this event</td></tr>'}</tbody>
  <tfoot><tr>
    <td colspan="4" style="text-align:right">TOTALS</td>
    <td class="r">${fmtWeightKg(data.totals.weightKg)}</td>
    <td class="r">${fmtWeightKg(data.totals.weightKg)}</td>
    <td class="r">${Math.floor(data.totals.value)}</td>
  </tr></tfoot>
</table>

<table class="boxes">
  ${box({ no: '37', label: 'Procedure (CPC)', lines: [] })}
  ${box(data.boxes[data.boxes.length - 1]!)}
</table>

<div class="notice">${esc(data.massNote)} ${esc(data.procedureNote)}</div>
</body></html>`;

  return html;
}
