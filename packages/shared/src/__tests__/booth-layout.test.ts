import { describe, expect, it } from 'vitest';
import {
  BOOTH_LAYOUT_MAX_PANELS,
  boothLayoutLabel,
  boothPreview,
  normalizeConfiguratorUrl,
  parseBoothLayout,
  sanitizeBoothLayout,
  summarizeBoothLayout,
} from '../booth-layout';

const panel = (type: string, x: number, y: number, z: number, extra: Record<string, unknown> = {}) => ({
  type, x, y, z, material: 'mesh', color: '#aabbcc', ...extra,
});

/** One open cube, 30 cm cells: two sides, a shelf under and over, a back. */
const cube = (extra: Record<string, unknown> = {}) => ({
  schema: 'cube-studio',
  version: 2,
  name: 'Single cube',
  width: 30,
  height: 30,
  depth: 30,
  panels: [
    panel('side', 0, 0, 0),
    panel('side', 1, 0, 0),
    panel('shelf', 0, 0, 0, { material: 'plastic' }),
    panel('shelf', 0, 1, 0, { material: 'plastic' }),
    panel('back', 0, 0, 0, { u: 1, v: 0.5 }),
  ],
  ...extra,
});

const parse = (raw: unknown) => parseBoothLayout(JSON.stringify(raw), { now: 42 });
const ok = (raw: unknown) => {
  const r = parse(raw);
  if (!r.ok) throw new Error(r.error);
  return r.layout;
};

describe('parseBoothLayout', () => {
  it('reads a version 2 design and keeps only known fields', () => {
    const layout = ok(cube({ evil: '<script>', table: { enabled: true } }));
    expect(layout).toMatchObject({ name: 'Single cube', width: 30, importedAt: 42 });
    expect(layout.panels).toHaveLength(5);
    expect(layout.panels[0]).toEqual({ type: 'side', x: 0, y: 0, z: 0, u: 1, v: 1, material: 'mesh', color: '#aabbcc' });
    expect(JSON.stringify(layout)).not.toContain('evil');
  });

  it('drops product artwork and stand meshes, keeping size and place', () => {
    const layout = ok(cube({
      products: [{ id: 'a', name: 'Print rack', width: 20, height: 40, depth: 10, x: 5, y: 30, z: 2, image: 'data:image/png;base64,AAAA', mesh: [], kind: 'stand', rotation: 1 }],
    }));
    expect(layout.products).toEqual([{ id: 'a', name: 'Print rack', width: 20, height: 40, depth: 10, x: 5, y: 30, z: 2, rotation: 1, kind: 'stand' }]);
  });

  it('migrates a version 1 cube design without duplicating shared panels', () => {
    const layout = ok({
      schema: 'cube-studio', version: 1, width: 30, height: 30, depth: 30, back: true,
      cubes: [{ x: 0, y: 0, z: 0, material: 'mesh', color: '#112233' }, { x: 1, y: 0, z: 0, material: 'mesh', color: '#112233' }],
    });
    // 3 side planes + 2 shelf rows of 2 + 2 backs.
    expect(layout.panels).toHaveLength(3 + 4 + 2);
  });

  it('refuses things that are not a design', () => {
    expect(parseBoothLayout('not json').ok).toBe(false);
    expect(parse([1, 2]).ok).toBe(false);
    expect(parse({ ...cube(), schema: 'other' }).ok).toBe(false);
    expect(parse({ ...cube(), version: 3 })).toMatchObject({ ok: false, error: expect.stringMatching(/version/) });
    expect(parse({ ...cube(), width: 5 }).ok).toBe(false);
    expect(parse({ ...cube(), width: '30' }).ok).toBe(false);
  });

  it('refuses malformed panels and products', () => {
    expect(parse(cube({ panels: [panel('roof', 0, 0, 0)] })).ok).toBe(false);
    expect(parse(cube({ panels: [panel('side', NaN, 0, 0)] })).ok).toBe(false);
    expect(parse(cube({ panels: [panel('side', 0, 0, 0, { u: 2 })] })).ok).toBe(false);
    expect(parse(cube({ panels: [panel('side', 99, 0, 0)] })).ok).toBe(false);
    expect(parse(cube({ panels: [panel('side', 0, 0, 0, { color: 'red' })] })).ok).toBe(false);
    expect(parse(cube({ panels: [panel('side', 0, 0, 0, { material: 'wood' })] })).ok).toBe(false);
    expect(parse(cube({ products: [{ id: 'a', width: 0, height: 1, depth: 1, x: 0, y: 0, z: 0 }] })).ok).toBe(false);
    expect(parse(cube({ products: [{ id: 'a', width: 1, height: 1, depth: 1, x: 0, y: 0, z: 0 }, { id: 'a', width: 1, height: 1, depth: 1, x: 0, y: 0, z: 0 }] })).ok).toBe(false);
  });

  it('caps the number of panels and the file size', () => {
    const many = Array.from({ length: BOOTH_LAYOUT_MAX_PANELS + 1 }, (_, i) => panel('side', 0, 0, 0, { z: i * 0.01 }));
    expect(parse(cube({ panels: many })).ok).toBe(false);
    expect(parseBoothLayout(' '.repeat(26 * 1024 * 1024)).ok).toBe(false);
  });

  it('ignores a duplicate panel and tidies the name', () => {
    const layout = ok(cube({ name: '  A\u0000B  ', panels: [panel('side', 0, 0, 0), panel('side', 0, 0, 0)] }));
    expect(layout.panels).toHaveLength(1);
    expect(layout.name).toBe('A B');
    expect(ok(cube({ name: 42 })).name).toBe('Booth layout');
  });

  it('records the file name', () => {
    const r = parseBoothLayout(JSON.stringify(cube()), { fileName: 'booth.json' });
    expect(r.ok && r.layout.fileName).toBe('booth.json');
  });
});

describe('sanitizeBoothLayout', () => {
  it('passes a stored layout and rejects garbage', () => {
    const layout = ok(cube());
    expect(sanitizeBoothLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(sanitizeBoothLayout({ ...layout, panels: 'x' })).toBeUndefined();
    expect(sanitizeBoothLayout(null)).toBeUndefined();
  });
});

describe('summarizeBoothLayout', () => {
  it('counts panels, materials, connectors and the footprint', () => {
    const s = summarizeBoothLayout(ok(cube()));
    expect(s).toMatchObject({ panels: 5, full: 4, half: 1, mesh: 3, plastic: 2, connectors: 10 });
    expect(s.footprint).toEqual({ width: 30, depth: 30, height: 30 });
  });

  it('groups identical parts by size and material, long edge first', () => {
    const s = summarizeBoothLayout(ok(cube()));
    expect(s.parts).toEqual([
      { dims: [30, 30], material: 'mesh', count: 2 },
      { dims: [30, 30], material: 'plastic', count: 2 },
      { dims: [30, 15], material: 'mesh', count: 1 },
    ]);
  });

  it('scales with the cell size and handles half panels in the footprint', () => {
    const s = summarizeBoothLayout(ok({
      schema: 'cube-studio', version: 2, width: 40, height: 20, depth: 30,
      panels: [panel('shelf', 0, 0, 0, { u: 0.5 }), panel('shelf', 0.5, 0, 0, { u: 0.5 }), panel('back', 0, 0, 0, { v: 1 })],
    }));
    expect(s.footprint).toEqual({ width: 40, depth: 30, height: 20 });
    expect(s.half).toBe(2);
  });

  it('lists products and copes with an empty layout', () => {
    const l = ok(cube({ products: [{ id: 'a', name: 'Rack', width: 20, height: 40, depth: 10, x: 0, y: 0, z: 0 }] }));
    expect(summarizeBoothLayout(l).products).toEqual([{ name: 'Rack', width: 20, height: 40, depth: 10 }]);
    const empty = summarizeBoothLayout(ok(cube({ panels: [] })));
    expect(empty).toMatchObject({ panels: 0, connectors: 0, footprint: { width: 0, depth: 0, height: 0 } });
  });

  it('writes a one-line label', () => {
    expect(boothLayoutLabel(ok(cube()))).toBe('5 panels · 30 x 30 x 30 cm');
    expect(boothLayoutLabel(ok(cube({ panels: [] })))).toBe('0 panels');
  });
});

describe('boothPreview', () => {
  it('draws the top view with the back at the top', () => {
    const p = boothPreview(ok(cube()), 'top');
    expect(p.shapes).toHaveLength(5);
    const back = p.shapes[0]!;
    expect(back.kind).toBe('panel');
    expect(back.y).toBeLessThanOrEqual(p.shapes.find((s) => s.kind === 'shelf')!.y + 0.1);
    for (const s of p.shapes) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(p.width + 0.1);
      expect(s.y + s.h).toBeLessThanOrEqual(p.height + 0.1);
    }
  });

  it('draws the front view with height going up', () => {
    const l = ok(cube({ products: [{ id: 'a', name: 'Rack', width: 10, height: 10, depth: 10, x: 15, y: 0, z: 10 }] }));
    const p = boothPreview(l, 'front');
    const rack = p.shapes.find((s) => s.kind === 'product')!;
    const sideTop = p.shapes.find((s) => s.kind === 'panel' && s.h > 25)!;
    // The rack sits on the floor: its bottom edge is lower than the top of the side panels.
    expect(rack.y + rack.h).toBeGreaterThan(sideTop.y + sideTop.h - 0.1);
    expect(rack.label).toBe('Rack');
  });

  it('gives edge-on panels some thickness and is empty for no panels', () => {
    const p = boothPreview(ok(cube()), 'top');
    expect(p.shapes.every((s) => s.w > 0 && s.h > 0)).toBe(true);
    expect(boothPreview(ok(cube({ panels: [] })), 'front')).toEqual({ width: 0, height: 0, shapes: [] });
  });

  it('rotates a product footprint', () => {
    const l = ok(cube({ products: [{ id: 'a', name: 'R', width: 20, height: 5, depth: 10, x: 0, y: 0, z: 0, rotation: Math.PI / 2 }] }));
    const rack = boothPreview(l, 'top').shapes.find((s) => s.kind === 'product')!;
    expect(rack.w).toBe(10);
    expect(rack.h).toBe(20);
  });
});

describe('normalizeConfiguratorUrl', () => {
  it('keeps web addresses and adds https when missing', () => {
    expect(normalizeConfiguratorUrl('https://me.github.io/cube/')).toBe('https://me.github.io/cube/');
    expect(normalizeConfiguratorUrl(' me.github.io/cube ')).toBe('https://me.github.io/cube');
  });

  it('drops anything else', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x.test', 'http://']) expect(normalizeConfiguratorUrl(bad)).toBe('');
  });
});
