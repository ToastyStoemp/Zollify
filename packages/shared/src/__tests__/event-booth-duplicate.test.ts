import { describe, expect, it } from 'vitest';
import { boothFieldsForDuplicate } from '../event-booth';

const layout = {
  schema: 'cube-studio',
  version: 2,
  name: 'Single cube',
  width: 30,
  height: 30,
  depth: 30,
  panels: [{ type: 'side', x: 0, y: 0, z: 0, material: 'mesh', color: '#aabbcc' }],
};
const source = {
  booth: { hall: '3', number: 'B-12', link: 'https://example.com/b12', note: 'New prints' },
  boothLayout: layout as never,
  noPool: true as const,
};

describe('boothFieldsForDuplicate', () => {
  it('copies booth details, layout and noPool independently of the source', () => {
    const out = boothFieldsForDuplicate(source, 5);
    expect(out.booth).toEqual(source.booth);
    expect(out.booth).not.toBe(source.booth);
    expect(out.boothLayout?.panels).toHaveLength(1);
    expect(out.boothLayout?.importedAt).toBe(5);
    expect(out.noPool).toBe(true);
    out.booth!.hall = 'X';
    out.boothLayout!.panels.pop();
    expect(source.booth.hall).toBe('3');
    expect(layout.panels).toHaveLength(1);
  });

  it('sanitises an invalid stored layout and booth', () => {
    const out = boothFieldsForDuplicate({ booth: { link: 'http://insecure.example' }, boothLayout: { panels: 'nope' } as never });
    expect(out.boothLayout).toBeUndefined();
    expect(out.booth).toBeUndefined();
    expect(out.noPool).toBeUndefined();
  });

  it('copies nothing for a store', () => {
    expect(boothFieldsForDuplicate({ kind: 'store', ...source })).toEqual({});
  });
});
