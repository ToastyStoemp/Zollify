import type { PrintStory } from './story';

/** One story card: the print's title, its picture (a data: URL, so the page works away from this device) and its story. */
export interface StoryCardInput {
  title: string;
  /** Artist or product type, a small line above the title. */
  kicker?: string;
  image: string | null;
  /** The picture's width over its height, so a small picture is scaled up to the card without stretching. */
  aspect?: number;
  story: PrintStory;
}

export type CardSize = 'a5' | 'a4';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Paragraphs from text typed with blank lines between them; single line breaks are kept. */
function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function card(c: StoryCardInput, maxHeightMm: number): string {
  const dots = c.story.points
    .map((p, i) => `<span class="dot" style="left:${p.x}%;top:${p.y}%">${i + 1}</span>`)
    .join('');
  const picture = c.image
    ? `<div class="pic"${c.aspect && c.aspect > 0 ? ` style="width:min(100%,${Math.round(maxHeightMm * c.aspect * 10) / 10}mm)"` : ''}><img src="${esc(c.image)}" alt="${esc(c.title)}">${dots}</div>`
    : `<div class="pic none">No picture on this device</div>`;
  const list = c.story.points.length
    ? `<ol class="points">${c.story.points
        .map((p, i) => `<li><span class="n">${i + 1}</span><div><strong>${esc(p.label || 'Detail')}</strong>${p.description ? paragraphs(p.description) : ''}</div></li>`)
        .join('')}</ol>`
    : '';
  return `<section class="card">
  ${picture}
  <div class="text">
    ${c.kicker ? `<div class="kicker">${esc(c.kicker)}</div>` : ''}
    <h1>${esc(c.title)}</h1>
    ${c.story.intro.trim() ? `<div class="intro">${paragraphs(c.story.intro)}</div>` : ''}
    ${list}
  </div>
</section>`;
}

/**
 * Printable story cards, one print per page: the picture with its numbered
 * points, then the introduction and what each number shows. Opened in a
 * window of its own and printed from there, or saved as a PDF.
 */
export function storyCardsHtml(cards: StoryCardInput[], opts: { size?: CardSize; shop?: string } = {}): string {
  const size = opts.size ?? 'a5';
  const maxH = size === 'a5' ? 95 : 140;
  const title = cards.length === 1 ? cards[0]!.title : `${opts.shop ? `${opts.shop} - ` : ''}Print stories`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: ${size === 'a5' ? 'A5' : 'A4'} portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.45 Georgia, 'Times New Roman', serif; color: #1d1b19; background: #f3efe8; }
  .card { background: #fffdf9; max-width: ${size === 'a5' ? '148mm' : '210mm'}; margin: 8mm auto; padding: 8mm; display: flex; flex-direction: column; gap: 5mm; page-break-after: always; break-after: page; }
  .card:last-child { page-break-after: auto; break-after: auto; }
  .pic { position: relative; align-self: center; max-width: 100%; }
  .pic img { display: block; max-width: 100%; max-height: ${maxH}mm; }
  .pic[style] img { width: 100%; height: auto; max-height: none; }
  .pic.none { padding: 20mm; color: #8a847c; border: 1px dashed #c9c1b5; font-family: system-ui, sans-serif; font-size: 9pt; }
  .dot { position: absolute; transform: translate(-50%, -50%); width: 6.5mm; height: 6.5mm; border-radius: 50%; background: #fffdf9; color: #1d1b19; border: .6mm solid #1d1b19; font: 700 8pt/5.3mm system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 .5mm rgba(255,253,249,.8); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .kicker { font: 600 8pt/1.2 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .12em; color: #7b7268; }
  h1 { margin: 1mm 0 2mm; font-size: 18pt; line-height: 1.15; font-weight: 600; }
  .intro p { margin: 0 0 2mm; }
  .points { list-style: none; margin: 3mm 0 0; padding: 0; display: flex; flex-direction: column; gap: 2.5mm; }
  .points li { display: flex; gap: 3mm; align-items: flex-start; break-inside: avoid; }
  .points .n { flex: none; width: 6mm; height: 6mm; border-radius: 50%; border: .5mm solid #1d1b19; font: 700 8pt/5mm system-ui, sans-serif; text-align: center; margin-top: .5mm; }
  .points strong { display: block; }
  .points p { margin: .5mm 0 0; font-size: 10pt; }
  @media print { body { background: none; } .card { margin: 0; padding: 0; max-width: none; } }
</style>
</head>
<body>
${cards.map((c) => card(c, maxH)).join('\n')}
</body>
</html>`;
}
