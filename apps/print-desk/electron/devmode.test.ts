import { describe, expect, it } from 'vitest';
import { decodeDevMode, describeDevMode } from './devmode.js';
import { parseCaps } from './printercaps.js';

// The public part of a Canon PRO-1000 driver's settings as PhotoCraft remembers them (A3 portrait,
// Highest Density Fine Art Paper, Manual Feed, high quality, colour management off), followed by
// the driver's 3796 private bytes (zeroed here).
const PUBLIC =
  '430061006e006f006e002000500052004f002d00310030003000300020007300650072006900650073000000000000000000000000000000000000000000000001040a0cdc00d40e03df81030100080068109a0b640001001501fcff02000100000001000100410033000000740065007200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000030000004b0100000100000000000000000000000000000000000000';
const PRO1000 = PUBLIC + '00'.repeat(3796);

describe('decodeDevMode', () => {
  it('reads the public fields of real driver settings', () => {
    expect(decodeDevMode(PRO1000)).toMatchObject({
      device: 'Canon PRO-1000 series',
      size: 220,
      privateBytes: 3796,
      orientation: 'portrait',
      paper: 8,
      formName: 'A3',
      copies: 1,
      source: 277,
      quality: -4,
      color: 'color',
      mediaType: 331,
      icmMethod: 1,
      icmIntent: 3,
    });
  });
  it('reads landscape from dmOrientation', () => {
    const turned = PRO1000.slice(0, 152) + '0200' + PRO1000.slice(156);
    expect(decodeDevMode(turned)?.orientation).toBe('landscape');
  });
  it('ignores a field whose dmFields bit is clear', () => {
    // dmFields at byte 72: clear DM_MEDIATYPE (0x02000000), the top byte's 0x02 bit.
    const b = Buffer.from(PRO1000, 'hex');
    b[75] &= ~0x02;
    expect(decodeDevMode(b.toString('hex'))?.mediaType).toBeNull();
  });
  it('rejects hex that is not driver settings', () => {
    expect(decodeDevMode('')).toBeNull();
    expect(decodeDevMode('zz')).toBeNull();
    expect(decodeDevMode(PUBLIC)).toBeNull(); // private bytes missing
    expect(decodeDevMode(PRO1000 + '00')).toBeNull();
    expect(decodeDevMode('00'.repeat(100))).toBeNull();
  });
});

const wide = (s: string, chars: number): Buffer => {
  const b = Buffer.alloc(chars * 2);
  b.write(s, 'utf16le');
  return b;
};
const u16 = (...n: number[]): string => Buffer.from(new Uint16Array(n).buffer).toString('base64');
const u32 = (...n: number[]): string => Buffer.from(new Uint32Array(n).buffer).toString('base64');
const i32 = (...n: number[]): string => Buffer.from(new Int32Array(n).buffer).toString('base64');
const CAPS = parseCaps({
  papers: u16(9, 8),
  paperNames: Buffer.concat([wide('A4', 64), wide('A3', 64)]).toString('base64'),
  paperSizes: i32(2100, 2970, 2970, 4200),
  bins: u16(277),
  binNames: wide('Manual Feed', 24).toString('base64'),
  media: u32(315, 331),
  mediaNames: Buffer.concat([wide('Photo Paper Pro Luster', 64), wide('Highest Density Fine Art Paper', 64)]).toString('base64'),
});

describe('parseCaps', () => {
  it('pairs the driver codes with its names and sizes', () => {
    expect(CAPS).toEqual({
      papers: [
        { id: 9, name: 'A4', widthMm: 210, heightMm: 297 },
        { id: 8, name: 'A3', widthMm: 297, heightMm: 420 },
      ],
      sources: [{ id: 277, name: 'Manual Feed' }],
      mediaTypes: [
        { id: 315, name: 'Photo Paper Pro Luster' },
        { id: 331, name: 'Highest Density Fine Art Paper' },
      ],
    });
  });
  it('keeps codes without a name', () => {
    expect(parseCaps({ papers: u16(8), paperNames: '', paperSizes: '', bins: '', binNames: '', media: u32(5), mediaNames: '' })).toEqual({
      papers: [{ id: 8, name: 'code 8', widthMm: 0, heightMm: 0 }],
      sources: [],
      mediaTypes: [{ id: 5, name: 'code 5' }],
    });
  });
});

describe('describeDevMode', () => {
  const lines = (caps?: typeof CAPS) => Object.fromEntries(describeDevMode(decodeDevMode(PRO1000)!, caps).map((l) => [l.label, l.value]));
  it('names driver codes from the printer catalog', () => {
    expect(lines(CAPS)).toEqual({
      Printer: 'Canon PRO-1000 series',
      Paper: 'A3 (297 × 420 mm)',
      Orientation: 'portrait',
      'Media type': 'Highest Density Fine Art Paper',
      'Paper source': 'Manual Feed',
      Quality: 'high',
      Colour: 'color',
      'Colour management': 'off (the application manages colour)',
      'Rendering intent': 'relative colorimetric',
      'Driver data': '3796 bytes only the driver reads (its own options, such as borderless)',
    });
  });
  it('falls back to the form name and codes without a catalog', () => {
    const l = lines();
    expect(l.Paper).toBe('A3');
    expect(l['Media type']).toBe('code 331');
    expect(l['Paper source']).toBe('code 277');
  });
});
