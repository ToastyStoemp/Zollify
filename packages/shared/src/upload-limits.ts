import { BOOTH_LAYOUT_MAX_BYTES } from './booth-layout';
import { formatFileSize } from './event-files';

/**
 * One definition of what a file upload may be, shared so the app refuses a file
 * before sending it and the server refuses the same file if it arrives anyway.
 *
 * The type of a file is read from its first bytes. The browser's Content-Type
 * and the file's name are never trusted: they only pick between spellings of a
 * type the bytes already proved (text/plain or text/csv for a text file), and a
 * claim that contradicts the bytes is refused.
 */

const MB = 1024 * 1024;

/** What the first bytes of a file say it is. `markup` is HTML, SVG or XML: never accepted anywhere. */
export type FileKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'heic' | 'pdf' | 'zip' | 'ole' | 'psd' | 'tiff' | 'eps' | 'text' | 'markup' | 'unknown';

/** How many leading bytes `sniffFileKind` needs. */
export const SNIFF_BYTES = 4096;

const KIND_LABEL: Record<FileKind, string> = {
  png: 'PNG picture',
  jpeg: 'JPEG picture',
  webp: 'WebP picture',
  gif: 'GIF picture',
  heic: 'HEIC picture',
  pdf: 'PDF',
  zip: 'zip-based file',
  ole: 'old Excel file',
  psd: 'Photoshop file',
  tiff: 'TIFF picture',
  eps: 'EPS file',
  text: 'text file',
  markup: 'web page or markup file',
  unknown: 'unrecognised file',
};

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, text: string): boolean => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Decides what a file is from its first bytes (`SNIFF_BYTES` is plenty). */
export function sniffFileKind(head: Uint8Array): FileKind {
  if (head.length < 4) return head.length > 0 && looksLikeText(head) ? 'text' : 'unknown';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'gif';
  if (ascii(head, 0, '%PDF-')) return 'pdf';
  if (ascii(head, 4, 'ftyp') && HEIC_BRANDS.has(String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!))) return 'heic';
  // Empty and spanned archives share the signature; the reader of a zip handles those.
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (ascii(head, 0, '8BPS')) return 'psd';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (ascii(head, 0, '%!PS') || startsWith(head, [0xc5, 0xd0, 0xd3, 0xc6])) return 'eps';
  if (!looksLikeText(head)) return 'unknown';
  return looksLikeMarkup(head) ? 'markup' : 'text';
}

/** No NUL bytes and valid UTF-8 (a character cut by the end of the sample is fine). */
function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** HTML, SVG and XML all open with a tag (or a doctype/declaration); text that does is never wanted. */
function looksLikeMarkup(head: Uint8Array): boolean {
  const start = new TextDecoder().decode(head.subarray(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  return start.startsWith('<');
}

/** One kind a purpose accepts: its own size cap, and the Content-Types a client may claim for it (the first is the one stored). */
export interface KindRule {
  maxBytes: number;
  mimes: readonly string[];
}

export interface UploadPurpose {
  /** Shown in messages: "a logo", "an invoice". */
  noun: string;
  kinds: Partial<Record<FileKind, KindRule>>;
}

const IMAGE_MAX = 5 * MB;
const PDF_MAX = 10 * MB;
const rule = (maxBytes: number, ...mimes: string[]): KindRule => ({ maxBytes, mimes });

const PHOTOS = {
  png: rule(IMAGE_MAX, 'image/png'),
  jpeg: rule(IMAGE_MAX, 'image/jpeg', 'image/jpg', 'image/pjpeg'),
  webp: rule(IMAGE_MAX, 'image/webp'),
} satisfies Partial<Record<FileKind, KindRule>>;

/**
 * Every place the app takes a file. "server" purposes are also enforced where
 * the bytes arrive; the rest are read in the browser (an import is parsed on
 * the device, never uploaded as a file) and only bounded there.
 */
export const UPLOAD_PURPOSES = {
  /** Tickets, floor plans and schedules attached to an event. Served back, so nothing a browser would run. */
  eventFile: {
    noun: 'a file for an event',
    kinds: {
      ...PHOTOS,
      gif: rule(IMAGE_MAX, 'image/gif'),
      heic: rule(IMAGE_MAX, 'image/heic', 'image/heif'),
      pdf: rule(PDF_MAX, 'application/pdf'),
      text: rule(2 * MB, 'text/plain', 'text/csv'),
      zip: rule(
        PDF_MAX,
        'application/vnd.apple.pkpass',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    },
  },
  /** The PDF kept with a ledger expense. */
  invoice: { noun: 'an invoice', kinds: { pdf: rule(PDF_MAX, 'application/pdf') } },
  /** The PDF read by the invoice scanner, which is sent on to a paid API. */
  invoiceScan: { noun: 'an invoice to scan', kinds: { pdf: rule(5 * MB, 'application/pdf') } },
  /** The PDF attached to a booking in the accounting software. */
  voucher: { noun: 'a voucher', kinds: { pdf: rule(PDF_MAX, 'application/pdf') } },
  /** Design files and proofs in a sourcing dossier: print-ready work, not video. */
  designFile: {
    noun: 'a design file',
    kinds: {
      png: rule(25 * MB, 'image/png'),
      jpeg: rule(25 * MB, 'image/jpeg', 'image/jpg'),
      webp: rule(25 * MB, 'image/webp'),
      gif: rule(25 * MB, 'image/gif'),
      pdf: rule(25 * MB, 'application/pdf', 'application/illustrator'),
      tiff: rule(25 * MB, 'image/tiff'),
      psd: rule(25 * MB, 'image/vnd.adobe.photoshop', 'application/x-photoshop'),
      eps: rule(25 * MB, 'application/postscript', 'application/eps', 'image/eps'),
      zip: rule(25 * MB, 'application/zip', 'application/x-zip-compressed'),
    },
  },
  /** The logo on receipts. Already re-encoded to a small PNG by the device, and shown to strangers. */
  logo: { noun: 'a logo', kinds: { png: rule(256 * 1024, 'image/png') } },
  /** A customer's reference picture for a commission. */
  referenceImage: { noun: 'a picture', kinds: PHOTOS },
  /** A picture picked on the device before it is shrunk to a thumbnail (product photos, the logo source): a phone camera file, never uploaded as it is. */
  pickedImage: {
    noun: 'a picture',
    kinds: {
      png: rule(25 * MB, 'image/png'),
      jpeg: rule(25 * MB, 'image/jpeg', 'image/jpg', 'image/pjpeg'),
      webp: rule(25 * MB, 'image/webp'),
      gif: rule(25 * MB, 'image/gif'),
      heic: rule(25 * MB, 'image/heic', 'image/heif'),
    },
  },
  /** This device's own backup (JSON) to restore. */
  backupJson: { noun: 'a backup', kinds: { text: rule(64 * MB, 'application/json', 'text/plain', 'text/json') } },
  /** A ZollTool backup to import: JSON, or a zip with the photos beside it. */
  backupImport: {
    noun: 'a backup',
    kinds: { text: rule(64 * MB, 'application/json', 'text/plain', 'text/json'), zip: rule(256 * MB, 'application/zip', 'application/x-zip-compressed') },
  },
  /** A payments export read in the browser. */
  spreadsheetImport: {
    noun: 'a payments export',
    kinds: {
      text: rule(25 * MB, 'text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'),
      zip: rule(25 * MB, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ole: rule(25 * MB, 'application/vnd.ms-excel'),
    },
  },
  /** A booth layout saved as JSON. */
  jsonImport: { noun: 'a layout file', kinds: { text: rule(BOOTH_LAYOUT_MAX_BYTES, 'application/json', 'text/plain', 'text/json') } },
  /** A PEM key file pasted into a settings form. */
  keyFile: { noun: 'a key file', kinds: { text: rule(16 * 1024, 'text/plain', 'application/x-pem-file', 'application/pkcs8') } },
} as const satisfies Record<string, UploadPurpose>;

export type UploadPurposeId = keyof typeof UPLOAD_PURPOSES;

/** A name ending like this is refused whatever the bytes are: it is what a later download would be opened as. */
const BLOCKED_EXTENSION = /\.(html?|xhtml|svgz?|xml|js|mjs|exe|bat|cmd|sh|msi|jar)$/i;

export type UploadProblem = 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch';

export interface UploadRefusal {
  ok: false;
  /** The HTTP status the server answers with. */
  status: 400 | 413 | 415;
  error: UploadProblem;
  /** Readable as it stands; shown to the person. */
  message: string;
}
export interface UploadAccepted {
  ok: true;
  kind: FileKind;
  /** What to store as the file's type: from the bytes, never the client's claim. */
  mime: string;
}
export type UploadCheck = UploadAccepted | UploadRefusal;

const refuse = (status: UploadRefusal['status'], error: UploadProblem, message: string): UploadRefusal => ({ ok: false, status, error, message });

const sizeLabel = (bytes: number): string => formatFileSize(bytes).replace('.0 MB', ' MB');

/** The biggest file this purpose takes of any type. */
export const maxBytesFor = (purpose: UploadPurposeId): number => Math.max(...Object.values<KindRule>(UPLOAD_PURPOSES[purpose].kinds).map((k) => k.maxBytes));

/** A readable list of what the purpose takes: "PDF, PNG picture or JPEG picture". */
export function allowedKinds(purpose: UploadPurposeId): string {
  const names = (Object.keys(UPLOAD_PURPOSES[purpose].kinds) as FileKind[]).map((k) => KIND_LABEL[k]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? 'nothing');
}

const bareMime = (mime: string | undefined): string => (mime ?? '').split(';')[0]!.trim().toLowerCase();
/** Types that say "I don't know": they claim nothing, so there is nothing to contradict. */
const NO_CLAIM = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export interface UploadFacts {
  /** The real size in bytes. */
  size: number;
  /** The first `SNIFF_BYTES` bytes (or all of a smaller file). */
  head: Uint8Array;
  /** What the client says it is. Optional; contradicted claims are refused. */
  claimedMime?: string;
  name?: string;
}

/** The one decision both the app and the server make about a file. */
export function checkUpload(purposeId: UploadPurposeId, f: UploadFacts): UploadCheck {
  const purpose: UploadPurpose = UPLOAD_PURPOSES[purposeId];
  if (f.size <= 0) return refuse(400, 'empty', 'That file is empty.');
  if (f.name && BLOCKED_EXTENSION.test(f.name.trim())) return refuse(415, 'unsupported_type', `Web pages, scripts and programs cannot be uploaded. Use ${allowedKinds(purposeId)}.`);
  const biggest = maxBytesFor(purposeId);
  if (f.size > biggest) return refuse(413, 'too_large', `That file is ${sizeLabel(f.size)}; the limit for ${purpose.noun} is ${sizeLabel(biggest)}.`);

  const kind = sniffFileKind(f.head);
  if (kind === 'markup') return refuse(415, 'unsupported_type', `HTML, SVG and other markup files cannot be uploaded. Use ${allowedKinds(purposeId)}.`);
  const kindRule = (purpose.kinds as Partial<Record<FileKind, KindRule>>)[kind];
  if (!kindRule) {
    return refuse(415, 'unsupported_type', `That file is not a type that can be uploaded as ${purpose.noun}. Use ${allowedKinds(purposeId)}.`);
  }
  if (f.size > kindRule.maxBytes) {
    return refuse(413, 'too_large', `That ${KIND_LABEL[kind]} is ${sizeLabel(f.size)}; the limit is ${sizeLabel(kindRule.maxBytes)}.`);
  }
  const claimed = bareMime(f.claimedMime);
  if (!NO_CLAIM.has(claimed) && !kindRule.mimes.includes(claimed)) {
    return refuse(415, 'type_mismatch', `That file says it is ${claimed}, but its contents are a ${KIND_LABEL[kind]}. It was not uploaded.`);
  }
  return { ok: true, kind, mime: kindRule.mimes.includes(claimed) ? claimed : kindRule.mimes[0]! };
}

/** What a browser file picker hands over. */
export interface PickedFile {
  name: string;
  size: number;
  type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/**
 * Checks a picked file before it is read or sent: the same rules as the server.
 * Returns the message to show, or null when the file is fine.
 */
export async function checkPickedFile(purpose: UploadPurposeId, file: PickedFile): Promise<string | null> {
  // Size first: a file over the cap is refused without reading any of it.
  const head = file.size > 0 && file.size <= maxBytesFor(purpose) ? new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()) : new Uint8Array(0);
  const res = checkUpload(purpose, { size: file.size, head, claimedMime: file.type, name: file.name });
  return res.ok ? null : res.message;
}

/** Bytes a base64 string decodes to, without decoding it. */
export function base64DecodedSize(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** The request body size that fits a file of `maxBytes` sent as base64 in JSON, with room for the fields around it. */
export const base64BodyLimit = (maxBytes: number, overhead = 8 * 1024): number => Math.ceil((maxBytes * 4) / 3) + overhead;

/** The sync push carries ops (including image thumbnails), not files: the device batches under 4 MB, so twice that is the ceiling. */
export const SYNC_PUSH_MAX_BYTES = 8 * MB;
