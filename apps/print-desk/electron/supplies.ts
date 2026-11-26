import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Supply } from './shared.js';

const run = promisify(execFile);

/**
 * Ink and maintenance cartridge levels, from the printer itself. A Canon inkjet on the network
 * serves its Remote UI's status as a script, /JS_MDL/model.js: each ink tank as
 * `inktank[i]=[colour, level, warning]` and the maintenance cartridge as
 * `g_cartridge_rest = [level, warning]`, in the 10% steps the Remote UI draws. (Its SNMP supplies
 * table names the tanks but gives every level as unknown, and Windows knows only "low ink".)
 */

/** The Remote UI's colour codes (its inkSYM list), as Canon names the tanks. */
const COLOUR = ['BK', 'PGBK', 'C', 'M', 'Y', 'GY', 'Color', 'Black', 'Ink 8', 'Ink 9', 'PM', 'PC', 'R', 'Y', 'PBK', 'CO', 'MBK', 'PGY', 'B'];
const INK_STATE: Supply['state'][] = ['ok', 'low', 'out', 'unknown'];
const CARTRIDGE_STATE: Supply['state'][] = ['ok', 'low', 'out'];
export const MAINTENANCE_ID = 'maintenance';

/** The supplies in a Canon Remote UI model.js; [] when it has none. */
export function parseCanonModel(js: string): Supply[] {
  const out: Supply[] = [];
  for (const m of js.matchAll(/inktank\[(\d+)\]\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g)) {
    const name = COLOUR[Number(m[2])] ?? `Ink ${m[2]}`;
    const step = Number(m[3]);
    // Steps from full: 0 is 100%, 10 is 0%, 11 is empty.
    out.push({ id: name, name, kind: 'ink', level: step <= 10 ? 100 - step * 10 : 0, state: INK_STATE[Number(m[4])] ?? 'unknown' });
  }
  const c = /g_cartridge_rest\s*=\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(js);
  if (c && c[1] !== '-1') {
    // Steps from empty: 0 is none left, 10 is 100% left.
    out.push({ id: MAINTENANCE_ID, name: 'Maintenance cartridge', kind: 'maintenance', level: Math.max(0, Math.min(10, Number(c[1]))) * 10, state: CARTRIDGE_STATE[Number(c[2])] ?? 'unknown' });
  }
  return out;
}

/** The network address of a printer's port (a Standard TCP/IP port), '' when it has none. */
async function hostOf(printer: string): Promise<string> {
  if (process.platform !== 'win32' || !printer) return '';
  try {
    const { stdout } = await run(
      'powershell.exe',
      // The name goes in the environment: -Command splits arguments on spaces.
      ['-NoProfile', '-NonInteractive', '-Command', '$p = Get-Printer -Name $env:PRINT_DESK_PRINTER -ErrorAction Stop; (Get-PrinterPort -Name $p.PortName -ErrorAction Stop).PrinterHostAddress'],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, PRINT_DESK_PRINTER: printer } },
    );
    const host = stdout.trim();
    return /^[\w.:-]+$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

const hosts = new Map<string, string>();
/** The printer's supplies; null when it can't be asked (not on the network, not a Canon inkjet). */
export async function readSupplies(printer: string): Promise<Supply[] | null> {
  let host = hosts.get(printer);
  if (host === undefined) hosts.set(printer, (host = await hostOf(printer)));
  if (!host) return null;
  try {
    const res = await fetch(`http://${host}/JS_MDL/model.js`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const supplies = parseCanonModel(await res.text());
    return supplies.length ? supplies : null;
  } catch {
    // Off, or its address changed: look it up again next time.
    hosts.delete(printer);
    return null;
  }
}
