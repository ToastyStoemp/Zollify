import type { MonitorState } from './statusmonitor.js';

/**
 * How long a sheet takes to print, learned from the printer's status monitor: per item, and from
 * those per paper size for items not timed yet. Only the printer's own time counts - a wait for
 * someone to load a sheet and press OK is left out - so a run's estimate is the printing alone.
 */

/** An item's mean time per sheet, over its last `n` sheets. */
export interface PrintTime {
  n: number;
  ms: number;
}

/** Sheets timed outside this are not a sheet printing (a stall, a blip between two prompts). */
export const MIN_SHEET_MS = 15_000;
export const MAX_SHEET_MS = 30 * 60_000;
/** The mean follows the last this many sheets, so a changed setting or printer shows soon. */
const KEEP = 20;

/**
 * Times sheets from the monitor's states: a sheet starts when the printer goes on by itself (the
 * prompt closed, or the page counter moved on) and ends at the next prompt, page, another
 * document, or `stop` (the job left the queue). Gives each finished sheet's document and time.
 * The first sheet of a job without prompts is not timed: its start is the spooling too.
 */
// ponytail: heuristic on the monitor's window text; if Canon's monitor shows the page late, times run long.
export function sheetTimer(): { see(s: MonitorState, now: number): { document: string; ms: number } | null; stop(now: number): { document: string; ms: number } | null } {
  let last: MonitorState | null = null;
  let start: { document: string; at: number; t: number } | null = null;
  const end = (now: number) => {
    const s = start;
    start = null;
    if (!s) return null;
    const ms = now - s.t;
    return ms >= MIN_SHEET_MS && ms <= MAX_SHEET_MS ? { document: s.document, ms } : null;
  };
  return {
    see(s, now) {
      const was = last;
      last = s;
      const printing = !s.prompt && !!s.document && !!s.page;
      let done: { document: string; ms: number } | null = null;
      if (start && (!printing || s.document !== start.document || s.page!.at !== start.at)) done = end(now);
      if (printing && !start && was && was.document === s.document) {
        const goesOn = !!was.prompt || (!!was.page && was.page.at < s.page!.at);
        if (goesOn) start = { document: s.document, at: s.page!.at, t: now };
      }
      return done;
    },
    stop: end,
  };
}

/** `t` with one more sheet of `ms`. */
export const addTime = (t: PrintTime | undefined, ms: number): PrintTime => {
  const n = Math.min(KEEP, (t?.n ?? 0) + 1);
  return { n, ms: Math.round(t ? t.ms + (ms - t.ms) / n : ms) };
};

/** Mean per sheet of each paper size, weighted by the sheets behind each item's time. */
export function sizeTimes(times: Record<string, PrintTime>, sizeOf: (key: string) => string | undefined): Record<string, PrintTime> {
  const sum: Record<string, { n: number; total: number }> = {};
  for (const [key, t] of Object.entries(times)) {
    const size = sizeOf(key);
    if (!size) continue;
    const s = (sum[size] ??= { n: 0, total: 0 });
    s.n += t.n;
    s.total += t.n * t.ms;
  }
  return Object.fromEntries(Object.entries(sum).map(([size, s]) => [size, { n: s.n, ms: Math.round(s.total / s.n) }]));
}

/**
 * How long copies take to print: each at its item's time, else its size's. `unknown` counts the
 * copies with neither (an item and size never timed), which the time leaves out.
 */
export function estimate(copies: { key: string; size: string; copies: number }[], times: Record<string, PrintTime>, bySize: Record<string, PrintTime>): { ms: number; unknown: number } {
  let ms = 0;
  let unknown = 0;
  for (const c of copies) {
    const t = times[c.key] ?? bySize[c.size];
    if (t) ms += t.ms * c.copies;
    else unknown += c.copies;
  }
  return { ms, unknown };
}

/** "1 h 05 min", "12 min", "40 s". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
