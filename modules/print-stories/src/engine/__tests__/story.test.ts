import { describe, expect, it } from 'vitest';
import { addPoint, clampPercent, emptyStory, hasStory, movePoint, nextPointId, normalizeStory, parseHotspots, removePoint, storyKey, toShopifyHotspots, updatePoint } from '../story';
import { storyCardsHtml } from '../card';

/** As the Shopify theme's hotspot edit mode writes the metafield. */
const THEME_JSON = `[
  {
    "id": "detail-1",
    "label": "The bunny",
    "description": "Hiding behind the teapot.",
    "x": 42.18,
    "y": 61.5
  },
  {
    "id": "detail-2",
    "label": "The window",
    "description": "",
    "x": 80,
    "y": 12.33,
    "image": "https://cdn.shopify.com/s/files/window.jpg",
    "image_alt": "The real window"
  }
]`;

describe('points', () => {
  it('adds points numbered like the theme, clamped to the picture', () => {
    let s = addPoint(emptyStory('p1'), 12.3456, 140);
    s = addPoint(s, -5, 50, 'Moon');
    expect(s.points).toEqual([
      { id: 'detail-1', label: '', description: '', x: 12.35, y: 100 },
      { id: 'detail-2', label: 'Moon', description: '', x: 0, y: 50 },
    ]);
  });

  it('never reuses an id after a point was removed', () => {
    let s = addPoint(addPoint(emptyStory('p1'), 1, 1), 2, 2);
    s = removePoint(s, 'detail-1');
    s = addPoint(s, 3, 3);
    expect(s.points.map((p) => p.id)).toEqual(['detail-2', 'detail-3']);
    expect(nextPointId([{ id: 'detail-1', label: '', description: '', x: 0, y: 0 }])).toBe('detail-2');
  });

  it('updates, clamps and reorders', () => {
    let s = addPoint(addPoint(emptyStory('p1'), 1, 1), 2, 2);
    s = updatePoint(s, 'detail-2', { label: 'Cat', x: 101 });
    expect(s.points[1]).toMatchObject({ label: 'Cat', x: 100, y: 2 });
    s = movePoint(s, 'detail-2', -1);
    expect(s.points.map((p) => p.id)).toEqual(['detail-2', 'detail-1']);
    expect(movePoint(s, 'detail-2', -1)).toBe(s);
  });

  it('knows an empty story', () => {
    expect(hasStory(undefined)).toBe(false);
    expect(hasStory(emptyStory('p'))).toBe(false);
    expect(hasStory({ ...emptyStory('p'), intro: 'Painted in Ghent' })).toBe(true);
    expect(storyKey('abc')).toBe('print-stories.story.abc');
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('Shopify hotspots format', () => {
  it('reads what the theme writes', () => {
    const r = parseHotspots(THEME_JSON);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points).toHaveLength(2);
    expect(r.points[1]).toEqual({ id: 'detail-2', label: 'The window', description: '', x: 80, y: 12.33, image: 'https://cdn.shopify.com/s/files/window.jpg', image_alt: 'The real window' });
  });

  it('round-trips to the same JSON the theme wrote', () => {
    const r = parseHotspots(THEME_JSON);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(toShopifyHotspots(r.points))).toEqual(JSON.parse(THEME_JSON));
  });

  it('leaves out an empty picture and an alt without a picture', () => {
    const out = JSON.parse(toShopifyHotspots([{ id: 'a', label: 'A', description: '', x: 1, y: 2, image: '', image_alt: 'orphan' }]));
    expect(out).toEqual([{ id: 'a', label: 'A', description: '', x: 1, y: 2 }]);
  });

  it('mends missing and repeated ids, accepts numbers as strings', () => {
    const r = parseHotspots([{ label: 'A', x: '10', y: '20' }, { id: 'detail-1', label: 'B', x: 1, y: 1 }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.points.map((p) => [p.id, p.x, p.y])).toEqual([['detail-1', 10, 20], ['detail-2', 1, 1]]);
  });

  it('says what is wrong', () => {
    expect(parseHotspots('{oops')).toMatchObject({ ok: false });
    expect(parseHotspots('{"x":1}')).toMatchObject({ ok: false, error: expect.stringContaining('list') });
    expect(parseHotspots([{ label: 'Lost' }])).toMatchObject({ ok: false, error: expect.stringContaining('Lost') });
    expect(parseHotspots('  ')).toEqual({ ok: true, points: [] });
  });

  it('normalises whatever was stored', () => {
    expect(normalizeStory('p', null)).toEqual(emptyStory('p'));
    expect(normalizeStory('p', { intro: 'Hi', points: 'nonsense', updatedAt: 5 })).toEqual({ productId: 'p', intro: 'Hi', points: [], updatedAt: 5 });
  });
});

describe('story cards', () => {
  it('numbers the dots and the list the same way and escapes text', () => {
    const story = addPoint(addPoint({ ...emptyStory('p'), intro: 'First.\n\nSecond <b>' }, 10, 20, 'Fox & hound'), 30, 40, 'Moon');
    const html = storyCardsHtml([{ title: 'Bunny "giclée"', kicker: 'Print', image: 'data:image/png;base64,AA', story }]);
    expect(html).toContain('left:10%;top:20%">1<');
    expect(html).toContain('left:30%;top:40%">2<');
    expect(html).toContain('<strong>Fox &amp; hound</strong>');
    expect(html).toContain('<p>Second &lt;b&gt;</p>');
    expect(html).toContain('<title>Bunny &quot;giclée&quot;</title>');
    expect(html).toContain('size: A5');
  });

  it('scales a small picture to the card by its shape', () => {
    const html = storyCardsHtml([{ title: 'T', image: 'data:image/png;base64,AA', aspect: 0.75, story: emptyStory('p') }]);
    expect(html).toContain('class="pic" style="width:min(100%,71.3mm)"');
  });

  it('prints without a picture', () => {
    const html = storyCardsHtml([{ title: 'T', image: null, story: emptyStory('p') }], { size: 'a4' });
    expect(html).toContain('No picture on this device');
    expect(html).toContain('size: A4');
  });
});
