import { describe, expect, it } from 'vitest';
import { addTime, duration, estimate, sheetTimer, sizeTimes } from './printtimes';
import type { MonitorState } from './statusmonitor';

const state = (at: number | null, prompt: string | null = null, document = 'kyoto.tif'): MonitorState => ({ prompt, status: '', document, page: at ? { at, of: 3 } : null });
const MIN = 60_000;

describe('sheetTimer', () => {
  it('times each sheet from the OK press to the next prompt, leaving the wait out', () => {
    const t = sheetTimer();
    expect(t.see(state(1, 'Load a sheet'), 0)).toBeNull();
    expect(t.see(state(1), 1 * MIN)).toBeNull(); // OK pressed after a minute's wait
    expect(t.see(state(2, 'Load a sheet'), 4 * MIN)).toEqual({ document: 'kyoto.tif', ms: 3 * MIN });
    t.see(state(2), 10 * MIN);
    expect(t.stop(13 * MIN)).toEqual({ document: 'kyoto.tif', ms: 3 * MIN });
  });
  it('times sheets by the page counter without prompts, but not the first (spooling)', () => {
    const t = sheetTimer();
    expect(t.see(state(1), 0)).toBeNull();
    expect(t.see(state(2), 5 * MIN)).toBeNull();
    expect(t.see(state(3), 7 * MIN)).toEqual({ document: 'kyoto.tif', ms: 2 * MIN });
    expect(t.see(state(null, null, ''), 9 * MIN)).toEqual({ document: 'kyoto.tif', ms: 2 * MIN });
  });
  it('drops a blip between a page and a prompt', () => {
    const t = sheetTimer();
    t.see(state(1, 'Load'), 0);
    t.see(state(1), MIN);
    expect(t.see(state(2), 4 * MIN)).toEqual({ document: 'kyoto.tif', ms: 3 * MIN });
    expect(t.see(state(2, 'Load'), 4 * MIN + 2000)).toBeNull();
  });
});

describe('estimates', () => {
  it('averages per item, then per size for items not timed yet', () => {
    let kyoto = addTime(undefined, 3 * MIN);
    kyoto = addTime(kyoto, 5 * MIN);
    expect(kyoto).toEqual({ n: 2, ms: 4 * MIN });
    const times = { kyoto, wave: { n: 2, ms: 2 * MIN } };
    const bySize = sizeTimes(times, () => 'a3');
    expect(bySize.a3).toEqual({ n: 4, ms: 3 * MIN });
    const copies = [
      { key: 'kyoto', size: 'a3', copies: 2 },
      { key: 'sunset', size: 'a3', copies: 1 },
      { key: 'tiny', size: 'a5', copies: 4 },
    ];
    expect(estimate(copies, times, bySize)).toEqual({ ms: 11 * MIN, unknown: 4 });
  });
  it('reads as hours and minutes', () => {
    expect(duration(40_000)).toBe('40 s');
    expect(duration(12 * MIN)).toBe('12 min');
    expect(duration(65 * MIN)).toBe('1 h 05 min');
  });
});
