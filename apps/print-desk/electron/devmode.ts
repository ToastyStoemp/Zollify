/**
 * Windows driver settings (a DEVMODEW, as PhotoCraft's `printerSettings` hex holds it) read as
 * names. The public part has a fixed layout (wingdi.h); codes up to 255 (256 for some fields) are
 * Windows' own, above that the driver's, named by the printer's catalog (printercaps.ts). The
 * driver's private part (`dmDriverExtra` bytes after the public ones) is opaque.
 */

export interface DevMode {
  device: string;
  /** Public part size and the driver's private bytes after it. */
  size: number;
  privateBytes: number;
  /** dmFields: which of the fields below the driver says are set. */
  fields: number;
  orientation: 'portrait' | 'landscape' | null;
  paper: number | null;
  /** Paper length and width in tenths of a millimetre, when set (custom sizes). */
  paperLength: number | null;
  paperWidth: number | null;
  formName: string | null;
  copies: number | null;
  source: number | null;
  quality: number | null;
  color: 'monochrome' | 'color' | null;
  duplex: 'simplex' | 'long edge' | 'short edge' | null;
  mediaType: number | null;
  icmMethod: number | null;
  icmIntent: number | null;
}

/** dmFields bits (wingdi.h). */
const DM = {
  ORIENTATION: 0x1,
  PAPERSIZE: 0x2,
  PAPERLENGTH: 0x4,
  PAPERWIDTH: 0x8,
  COPIES: 0x100,
  DEFAULTSOURCE: 0x200,
  PRINTQUALITY: 0x400,
  COLOR: 0x800,
  DUPLEX: 0x1000,
  FORMNAME: 0x10000,
  ICMMETHOD: 0x800000,
  ICMINTENT: 0x1000000,
  MEDIATYPE: 0x2000000,
} as const;

/** The smallest public part a driver writes (Windows 95's, up to dmICMIntent), as winprint checks. */
const DM_MIN = 156;

const text = (b: Buffer, at: number, bytes: number): string => b.subarray(at, at + bytes).toString('utf16le').replace(/\0.*$/s, '');

/** Reads driver settings hex; null when it isn't a DEVMODEW (too short, or its sizes don't add up). */
export function decodeDevMode(hex: string): DevMode | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const b = Buffer.from(hex, 'hex');
  if (b.length < DM_MIN) return null;
  const size = b.readUInt16LE(68);
  const privateBytes = b.readUInt16LE(70);
  if (size < DM_MIN || size + privateBytes !== b.length) return null;
  const fields = b.readUInt32LE(72);
  const has = (bit: number): boolean => (fields & bit) !== 0;
  // A field past the public part this driver wrote is absent, whatever dmFields says.
  const i16 = (bit: number, at: number): number | null => (has(bit) && at + 2 <= size ? b.readInt16LE(at) : null);
  const u32 = (bit: number, at: number): number | null => (has(bit) && at + 4 <= size ? b.readUInt32LE(at) : null);
  const orientation = i16(DM.ORIENTATION, 76);
  const color = i16(DM.COLOR, 92);
  const duplex = i16(DM.DUPLEX, 94);
  return {
    device: text(b, 0, 64),
    size,
    privateBytes,
    fields,
    orientation: orientation === 1 ? 'portrait' : orientation === 2 ? 'landscape' : null,
    paper: i16(DM.PAPERSIZE, 78),
    paperLength: i16(DM.PAPERLENGTH, 80),
    paperWidth: i16(DM.PAPERWIDTH, 82),
    formName: has(DM.FORMNAME) && size >= 166 ? text(b, 102, 64) || null : null,
    copies: i16(DM.COPIES, 86),
    source: i16(DM.DEFAULTSOURCE, 88),
    quality: i16(DM.PRINTQUALITY, 90),
    color: color === 1 ? 'monochrome' : color === 2 ? 'color' : null,
    duplex: duplex === 1 ? 'simplex' : duplex === 2 ? 'long edge' : duplex === 3 ? 'short edge' : null,
    mediaType: u32(DM.MEDIATYPE, 196),
    icmMethod: u32(DM.ICMMETHOD, 188),
    icmIntent: u32(DM.ICMINTENT, 192),
  };
}

/** A printer's own names for its codes, from the driver (printercaps.ts). */
export interface PrinterCaps {
  papers: { id: number; name: string; widthMm: number; heightMm: number }[];
  sources: { id: number; name: string }[];
  mediaTypes: { id: number; name: string }[];
}

/** Windows' own names, for codes a driver doesn't list. */
const QUALITY: Record<number, string> = { [-1]: 'draft', [-2]: 'low', [-3]: 'medium', [-4]: 'high' };
const ICM_METHOD: Record<number, string> = { 1: 'off (the application manages colour)', 2: 'Windows', 3: 'the driver', 4: 'the printer' };
const ICM_INTENT: Record<number, string> = { 1: 'saturation', 2: 'perceptual', 3: 'relative colorimetric', 4: 'absolute colorimetric' };

/** "ns0000:HighDensityFineArtPaper" → "High Density Fine Art Paper", "Level_2" → "Level 2". */
export const optionName = (q: string): string =>
  q.replace(/^[^:]*:/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

/** A driver option by feature, whatever namespace prefix the driver's ticket gave it. */
const pick = (options: Record<string, string>, feature: string): string | undefined =>
  Object.entries(options).find(([k]) => k.replace(/^[^:]*:/, '') === feature)?.[1];

export interface DevModeSummary {
  label: string;
  value: string;
}

/**
 * The settings as label/value lines, naming driver codes from `caps` when given. `options` is the
 * driver's own reading (printercaps.ts driverOptions): it adds what only the driver's private data
 * holds, such as borderless, and its quality and colour correction replace the coarse public ones.
 */
export function describeDevMode(dm: DevMode, caps?: PrinterCaps, options: Record<string, string> = {}): DevModeSummary[] {
  const named = (list: { id: number; name: string }[] | undefined, id: number): string => list?.find((x) => x.id === id)?.name ?? `code ${id}`;
  const lines: DevModeSummary[] = [{ label: 'Printer', value: dm.device }];
  if (dm.paper !== null) {
    const p = caps?.papers.find((x) => x.id === dm.paper);
    lines.push({ label: 'Paper', value: p ? `${p.name} (${p.widthMm} × ${p.heightMm} mm)` : dm.formName ?? `code ${dm.paper}` });
  } else if (dm.formName) {
    lines.push({ label: 'Paper', value: dm.formName });
  }
  if (dm.orientation) lines.push({ label: 'Orientation', value: dm.orientation });
  const borderless = pick(options, 'PageBorderless');
  if (borderless) {
    const level = pick(options, 'PageBorderlessExpandLevel');
    const on = optionName(borderless) === 'Borderless';
    lines.push({ label: 'Borderless', value: on ? (level ? `on, extension ${optionName(level).toLowerCase()}` : 'on') : 'off' });
  }
  if (dm.mediaType !== null) lines.push({ label: 'Media type', value: named(caps?.mediaTypes, dm.mediaType) });
  if (dm.source !== null) lines.push({ label: 'Paper source', value: named(caps?.sources, dm.source) });
  const quality = pick(options, 'PageOutputQuality');
  if (quality) lines.push({ label: 'Quality', value: optionName(quality) });
  else if (dm.quality !== null) lines.push({ label: 'Quality', value: dm.quality > 0 ? `${dm.quality} dpi` : (QUALITY[dm.quality] ?? `code ${dm.quality}`) });
  if (dm.color) lines.push({ label: 'Colour', value: dm.color });
  if (dm.icmMethod !== null) lines.push({ label: 'Windows colour management', value: ICM_METHOD[dm.icmMethod] ?? `the driver's mode ${dm.icmMethod}` });
  const correction = pick(options, 'PageColorCorrection');
  if (correction) lines.push({ label: 'Driver colour correction', value: optionName(correction) });
  if (dm.icmIntent !== null) lines.push({ label: 'Rendering intent', value: ICM_INTENT[dm.icmIntent] ?? `code ${dm.icmIntent}` });
  if (dm.duplex && dm.duplex !== 'simplex') lines.push({ label: 'Two-sided', value: dm.duplex });
  if (!borderless) lines.push({ label: 'Driver data', value: `${dm.privateBytes} bytes only the driver reads (its own options, such as borderless)` });
  return lines;
}
