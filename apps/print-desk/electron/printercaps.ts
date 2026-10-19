import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrinterCaps } from './devmode.js';

const run = promisify(execFile);

/**
 * A printer's own catalog, read from its driver with DeviceCapabilitiesW: the papers (with size),
 * paper sources and media types it offers, each with the code its settings store and the name its
 * own dialog shows. Read-only: nothing is printed or changed. Windows only.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class PrinterCaps {
  [DllImport("winspool.drv", CharSet = CharSet.Unicode)]
  static extern int DeviceCapabilitiesW(string device, string port, ushort cap, IntPtr output, IntPtr devmode);
  public static byte[] Raw(string printer, string port, ushort cap, int itemBytes) {
    int n = DeviceCapabilitiesW(printer, port, cap, IntPtr.Zero, IntPtr.Zero);
    if (n <= 0) return new byte[0];
    IntPtr buf = Marshal.AllocHGlobal(n * itemBytes);
    try {
      int got = DeviceCapabilitiesW(printer, port, cap, buf, IntPtr.Zero);
      if (got <= 0) return new byte[0];
      byte[] b = new byte[Math.Min(n, got) * itemBytes];
      Marshal.Copy(buf, b, 0, b.Length);
      return b;
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@
$printer = $args[0]
$port = (Get-Printer -Name $printer).PortName
function raw($cap, $bytes) { [Convert]::ToBase64String([PrinterCaps]::Raw($printer, $port, $cap, $bytes)) }
# DC_PAPERS 2 (WORD), DC_PAPERNAMES 16 (64 WCHAR), DC_PAPERSIZE 3 (POINT, 0.1 mm),
# DC_BINS 6 (WORD), DC_BINNAMES 12 (24 WCHAR), DC_MEDIATYPES 35 (DWORD), DC_MEDIATYPENAMES 34 (64 WCHAR)
[pscustomobject]@{
  papers = raw 2 2; paperNames = raw 16 128; paperSizes = raw 3 8
  bins = raw 6 2; binNames = raw 12 48
  media = raw 35 4; mediaNames = raw 34 128
} | ConvertTo-Json -Compress
`;

interface RawCaps {
  papers: string;
  paperNames: string;
  paperSizes: string;
  bins: string;
  binNames: string;
  media: string;
  mediaNames: string;
}

/** Splits fixed-size records out of a base64 buffer. */
function records(b64: string, size: number): Buffer[] {
  const b = Buffer.from(b64 || '', 'base64');
  const out: Buffer[] = [];
  for (let at = 0; at + size <= b.length; at += size) out.push(b.subarray(at, at + size));
  return out;
}
const wide = (b: Buffer): string => b.toString('utf16le').replace(/\0.*$/s, '').trim();

/** The catalog from DeviceCapabilities' raw arrays: ids paired with names by position. */
export function parseCaps(raw: RawCaps): PrinterCaps {
  const ids = (b64: string, size: number): number[] => records(b64, size).map((r) => (size === 2 ? r.readUInt16LE(0) : r.readUInt32LE(0)));
  const names = (b64: string, size: number): string[] => records(b64, size).map(wide);
  const paperIds = ids(raw.papers, 2);
  const paperNames = names(raw.paperNames, 128);
  const sizes = records(raw.paperSizes, 8).map((r) => [r.readInt32LE(0) / 10, r.readInt32LE(4) / 10]);
  const pair = (idList: number[], nameList: string[]) => idList.map((id, i) => ({ id, name: nameList[i] || `code ${id}` }));
  return {
    papers: paperIds.map((id, i) => ({ id, name: paperNames[i] || `code ${id}`, widthMm: sizes[i]?.[0] ?? 0, heightMm: sizes[i]?.[1] ?? 0 })),
    sources: pair(ids(raw.bins, 2), names(raw.binNames, 48)),
    mediaTypes: pair(ids(raw.media, 4), names(raw.mediaNames, 128)),
  };
}

/**
 * The driver's own reading of driver settings: Windows asks the driver to turn the settings into a
 * PrintTicket, which names every option, the private ones (borderless, Canon's colour correction)
 * included. Read-only.
 */
const TICKET = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName ReachFramework, System.Printing
$hex = $args[1]
$bytes = New-Object byte[] ($hex.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
$conv = New-Object System.Printing.Interop.PrintTicketConverter($args[0], 1)
$t = $conv.ConvertDevModeToPrintTicket($bytes, [System.Printing.PrintTicketScope]::JobScope)
(New-Object IO.StreamReader($t.GetXmlStream())).ReadToEnd()
`;

/** A PrintTicket's chosen option per feature, by qualified name ("psk:PageBorderless": "psk:Borderless"). */
export function parseTicket(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<psf:Feature name="([^"]+)"[^>]*>\s*<psf:Option name="([^"]+)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const tickets = new Map<string, Record<string, string>>();

/** The driver's options for these settings ({} off Windows); asked once per settings per run. */
export async function driverOptions(printer: string, hex: string): Promise<Record<string, string>> {
  if (process.platform !== 'win32' || !/^[0-9a-f]+$/i.test(hex)) return {};
  const key = `${printer}\n${hex}`;
  const hit = tickets.get(key);
  if (hit) return hit;
  // The hex is checked to be hex above, so it is safe in the command line (up to ~16 KB of settings).
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${TICKET} } '${printer.replace(/'/g, "''")}' '${hex}'`], { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const options = parseTicket(stdout);
  tickets.set(key, options);
  return options;
}

const cache = new Map<string, PrinterCaps>();

/** The printer's catalog, asked once per printer per run (drivers can be slow to answer). */
export async function printerCaps(printer: string): Promise<PrinterCaps> {
  if (process.platform !== 'win32') return { papers: [], sources: [], mediaTypes: [] };
  const hit = cache.get(printer);
  if (hit) return hit;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${SCRIPT} } '${printer.replace(/'/g, "''")}'`], { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const caps = parseCaps(JSON.parse(stdout.trim()) as RawCaps);
  cache.set(printer, caps);
  return caps;
}
