import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

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
 *
 * jsPDF's own `html()` (which delegates pagination to an internal heuristic,
 * `autoPaging: 'text'`) was tried first and rejected: on a one-page form it
 * produced 17 mostly-blank pages, confirmed live. Slicing a single canvas by
 * a page-height computed from the actual render is deterministic - there is
 * no heuristic to get wrong - and correctly produces one page for
 * one-page content and several for anything taller, e.g. a long goods list.
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

    const canvas = await html2canvas(doc.body, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      windowWidth: pageWidthPx,
      height: doc.body.scrollHeight,
      windowHeight: doc.body.scrollHeight,
    });

    // Same ratio applies to height since the canvas is an unscaled rasterization of the page-width iframe.
    const pxPerMm = canvas.width / pageWidthMm;
    const pageHeightPx = Math.round(pageHeightMm * pxPerMm);

    const pdf = existing ?? new jsPDF({ unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' });
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    const sliceCtx = slice.getContext('2d');
    if (!sliceCtx) throw new Error('Could not prepare the PDF image.');

    // A new document always starts a new page; only the very first page of a fresh PDF is already there.
    for (let y = 0, first = !existing; y < canvas.height; y += pageHeightPx, first = false) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - y);
      // A page-tall sheet can round a pixel or two over A4 - not worth a blank page.
      if (!first && sliceHeightPx < pxPerMm * 2) break;
      slice.height = sliceHeightPx;
      sliceCtx.clearRect(0, 0, slice.width, slice.height);
      sliceCtx.drawImage(canvas, 0, y, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);
      if (!first) pdf.addPage([pageWidthMm, pageHeightMm], landscape ? 'l' : 'p');
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageWidthMm, sliceHeightPx / pxPerMm);
    }

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
