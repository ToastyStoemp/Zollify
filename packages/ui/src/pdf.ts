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

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' });
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    const sliceCtx = slice.getContext('2d');
    if (!sliceCtx) throw new Error('Could not prepare the PDF image.');

    for (let y = 0, first = true; y < canvas.height; y += pageHeightPx, first = false) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - y);
      slice.height = sliceHeightPx;
      sliceCtx.clearRect(0, 0, slice.width, slice.height);
      sliceCtx.drawImage(canvas, 0, y, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);
      if (!first) pdf.addPage([pageWidthMm, pageHeightMm], landscape ? 'l' : 'p');
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageWidthMm, sliceHeightPx / pxPerMm);
    }

    return pdf.output('blob');
  } finally {
    document.body.removeChild(iframe);
  }
}
