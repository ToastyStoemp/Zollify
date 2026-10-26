// Type-only: the runtime libraries (~900 KB together) load on first export,
// not before login - see renderInto.
import type { jsPDF } from 'jspdf';

/**
 * Renders one of the app's print-ready HTML documents (customs forms, goods
 * lists) into a real PDF file, entirely client-side.
 *
 * This exists because Android's Capacitor WebView has no working
 * print-to-PDF: `window.print()` is a silent no-op there, so the existing
 * "Print / Save as PDF" buttons never produced anything on Android. This
 * sidesteps the OS print pipeline entirely - the HTML is rendered into an
 * offscreen iframe (so its own CSS applies unmodified), rasterized whole by
 * html2canvas, then sliced into A4-height strips placed one per PDF page.
 * Where a strip ends is chosen from the live layout (see paginate) so a page
 * never cuts through a table row or a line of text, and a table carried over
 * to the next page gets its header row again.
 *
 * jsPDF's own `html()` (which delegates pagination to an internal heuristic,
 * `autoPaging: 'text'`) was tried first and rejected: on a one-page form it
 * produced 17 mostly-blank pages, confirmed live. Slicing a single canvas by
 * page breaks computed from the actual render is deterministic, and
 * correctly produces one page for one-page content and several for anything
 * taller, e.g. a long goods list.
 */
export async function htmlToPdf(html: string): Promise<Blob> {
  return htmlDocsToPdf([html]);
}

/**
 * Several documents in one PDF, each starting on a fresh page in its own
 * orientation - "export all documents" hands over one file per country
 * instead of one per document.
 */
export async function htmlDocsToPdf(htmls: string[]): Promise<Blob> {
  if (!htmls.length) throw new Error('Nothing to put in the PDF.');
  let pdf: jsPDF | null = null;
  for (const html of htmls) pdf = await renderInto(pdf, html);
  return pdf!.output('blob');
}

async function renderInto(existing: jsPDF | null, html: string): Promise<jsPDF> {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const landscape = /@page\s*\{[^}]*\blandscape\b/i.test(html);
  const pageWidthMm = landscape ? 297 : 210;
  const pageHeightMm = landscape ? 210 : 297;
  // A4 at 96 CSS px/inch - gives the offscreen iframe a realistic layout
  // width so text wraps the same way it would when actually printed.
  const pageWidthPx = landscape ? 1123 : 794;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;top:0;left:-10000px;width:${pageWidthPx}px;height:1px;border:0;`;
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Could not prepare the document for PDF export.');
    doc.open();
    doc.write(html);
    doc.close();
    applyPrintStyles(doc);

    await new Promise<void>((resolve) => {
      if (doc.readyState === 'complete') resolve();
      else iframe.addEventListener('load', () => resolve(), { once: true });
    });
    await (doc.fonts?.ready ?? Promise.resolve());

    const pxPerMmCss = pageWidthPx / pageWidthMm;
    const layout = measureLayout(doc);
    const pages = paginate(layout, pageHeightMm * pxPerMmCss, pxPerMmCss);

    const canvas = await html2canvas(doc.body, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      windowWidth: pageWidthPx,
      height: layout.height,
      windowHeight: layout.height,
    });

    const pdf = existing ?? new jsPDF({ unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' });
    // Canvas px per CSS px - the canvas is a straight rasterization of the page-width iframe.
    const k = canvas.width / pageWidthPx;
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    const sliceCtx = slice.getContext('2d');
    if (!sliceCtx) throw new Error('Could not prepare the PDF image.');
    const place = (fromCss: number, toCss: number, atMm: number): number => {
      const from = Math.round(fromCss * k);
      const h = Math.min(Math.round(toCss * k), canvas.height) - from;
      if (h <= 0) return atMm;
      slice.height = h;
      sliceCtx.fillStyle = '#ffffff';
      sliceCtx.fillRect(0, 0, slice.width, h);
      sliceCtx.drawImage(canvas, 0, from, canvas.width, h, 0, 0, canvas.width, h);
      const hMm = h / k / pxPerMmCss;
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, atMm, pageWidthMm, hMm);
      return atMm + hMm;
    };

    const marginMm = layout.margin / pxPerMmCss;
    pages.forEach((page, i) => {
      // A new document always starts a new page; only the very first page of a fresh PDF is already there.
      if (i > 0 || existing) pdf.addPage([pageWidthMm, pageHeightMm], landscape ? 'l' : 'p');
      let at = i === 0 ? 0 : marginMm;
      if (page.head) at = place(page.head.top, page.head.bottom, at);
      place(page.from, page.to, at);
      if (pages.length > 1) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7);
        pdf.setTextColor(120);
        pdf.text(`Page ${i + 1} / ${pages.length}`, pageWidthMm - Math.max(marginMm, 8), pageHeightMm - Math.max(marginMm, 8) / 2, {
          align: 'right',
          baseline: 'middle',
        });
      }
    });

    return pdf;
  } finally {
    document.body.removeChild(iframe);
  }
}

/**
 * Renders the document the way it prints, not the way it shows on screen.
 *
 * html2canvas has no print media, so the screen-only parts of a document -
 * the "Print / Save PDF" bar, the grey backdrop, the margin around the sheet
 * - used to land in the PDF too, and pushed a full-height form onto a second
 * page. A document that sets `data-pdf-media="print"` on its <html> has its
 * own `@media print` rules copied into a plain stylesheet, so they apply here
 * exactly as they would on paper.
 */
function applyPrintStyles(doc: Document): void {
  // Opt-in: most documents' print rules lean on the printer's page margins
  // (@page), which a PDF rendered here doesn't have.
  if (doc.documentElement.getAttribute('data-pdf-media') !== 'print') return;
  const rules: string[] = [];
  const collect = (list: CSSRuleList): void => {
    for (const rule of Array.from(list)) {
      if (rule instanceof doc.defaultView!.CSSMediaRule) {
        if (/\bprint\b/.test(rule.conditionText ?? rule.media.mediaText)) {
          for (const inner of Array.from(rule.cssRules)) {
            // @page has no meaning outside a print pipeline.
            if (!/^@page/i.test(inner.cssText)) rules.push(inner.cssText);
          }
        }
      }
    }
  };
  try {
    for (const sheet of Array.from(doc.styleSheets)) collect(sheet.cssRules);
  } catch {
    return; // a stylesheet we may not read - render as on screen
  }
  if (!rules.length) return;
  const style = doc.createElement('style');
  style.textContent = rules.join('\n');
  doc.head.appendChild(style);
}

export interface Span {
  top: number;
  bottom: number;
}

export interface Layout {
  /** Full document height, CSS px. */
  height: number;
  /** Where the content ends - the height less the body's bottom padding. */
  contentEnd: number;
  /** The document's own page margin (its body padding), reused on every page after the first. */
  margin: number;
  /** Boxes a page break must not cut through: table rows, lines of text, inline-blocks. */
  atoms: Span[];
  /** Each table's header row and the body it heads, to repeat the header on a continuation page. */
  tables: Array<{ head: Span; body: Span }>;
}

export interface Page {
  from: number;
  to: number;
  head?: Span;
}

/** Reads, in CSS px from the top of the body, everything paginate needs to place page breaks. */
function measureLayout(doc: Document): Layout {
  const view = doc.defaultView!;
  const body = doc.body;
  const origin = body.getBoundingClientRect().top;
  const span = (el: Element): Span => {
    const r = el.getBoundingClientRect();
    return { top: r.top - origin, bottom: r.bottom - origin };
  };
  const bodyStyle = view.getComputedStyle(body);
  const height = body.scrollHeight;
  const atoms: Span[] = [];
  for (const el of Array.from(body.querySelectorAll('*'))) {
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim() !== '');
    const atomic =
      el.tagName === 'TR' ||
      el.tagName === 'IMG' ||
      !el.firstElementChild ||
      hasText ||
      cs.display.startsWith('inline-') ||
      cs.breakInside.startsWith('avoid');
    if (!atomic) continue;
    const s = span(el);
    if (s.bottom - s.top > 0.5) atoms.push(s);
  }
  const tables: Layout['tables'] = [];
  for (const table of Array.from(body.querySelectorAll('table'))) {
    if (!table.tHead) continue;
    const head = span(table.tHead);
    tables.push({ head, body: { top: head.bottom, bottom: table.tFoot ? span(table.tFoot).bottom : span(table).bottom } });
  }
  return {
    height,
    contentEnd: height - (parseFloat(bodyStyle.paddingBottom) || 0),
    margin: parseFloat(bodyStyle.paddingTop) || 0,
    atoms,
    tables,
  };
}

/**
 * Splits the document into pages. The first page starts at the very top (the
 * body's padding is its margin); later pages get the same margin top and
 * bottom so nothing runs to the paper's edge, which most printers can't
 * reach. Each break is moved up to just above whatever row or line would
 * otherwise be cut.
 */
export function paginate(layout: Layout, pageHeight: number, pxPerMm: number): Page[] {
  const { height, contentEnd, margin, atoms, tables } = layout;
  // A page-tall sheet can round a pixel or two over A4 - not worth a second page.
  const slack = 2 * pxPerMm;
  const pages: Page[] = [];
  let y = 0;
  while (pages.length === 0 || y < contentEnd - 0.5) {
    const first = pages.length === 0;
    const table = first ? undefined : tables.find((t) => y >= t.body.top - 0.5 && y < t.body.bottom - 0.5);
    const head = table?.head;
    const top = first ? 0 : margin;
    const headH = head ? head.bottom - head.top : 0;
    const room = pageHeight - top - headH;
    if (contentEnd <= y + room - margin + slack) {
      pages.push({ from: y, to: Math.min(height, y + room), head });
      break;
    }
    const to = findBreak(atoms, y, y + room - margin, room);
    pages.push({ from: y, to, head });
    y = to;
  }
  return pages;
}

function findBreak(atoms: Span[], from: number, limit: number, room: number): number {
  let y = limit;
  for (;;) {
    let cut: Span | undefined;
    for (const a of atoms) {
      // Taller than a page: can't be kept whole anyway.
      if (a.bottom - a.top >= room) continue;
      if (a.top < y - 0.5 && a.bottom > y + 0.5 && (!cut || a.top < cut.top)) cut = a;
    }
    if (!cut) return y;
    // Nowhere sensible to break above - cut at the limit rather than leave a near-empty page.
    if (cut.top - from < room / 3) return limit;
    y = cut.top;
  }
}
