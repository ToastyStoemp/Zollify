import { describe, expect, it } from 'vitest';
import {
  UPLOAD_PURPOSES,
  base64BodyLimit,
  base64DecodedSize,
  checkPickedFile,
  checkUpload,
  maxBytesFor,
  sniffFileKind,
  type UploadPurposeId,
} from '../upload-limits';

const MB = 1024 * 1024;
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46);
const PDF = text('%PDF-1.7\n%....');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const HTML = text('<!DOCTYPE html><script>alert(1)</script>');

describe('sniffFileKind', () => {
  it('reads the type from the first bytes', () => {
    expect(sniffFileKind(PNG)).toBe('png');
    expect(sniffFileKind(JPEG)).toBe('jpeg');
    expect(sniffFileKind(text('GIF89a....'))).toBe('gif');
    expect(sniffFileKind(PDF)).toBe('pdf');
    expect(sniffFileKind(Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBPVP8 ')]))).toBe('webp');
    expect(sniffFileKind(Uint8Array.from([0, 0, 0, 0x18, ...text('ftypheic'), 0, 0, 0, 0]))).toBe('heic');
    expect(sniffFileKind(bytes(0x50, 0x4b, 0x03, 0x04, 20, 0))).toBe('zip');
    expect(sniffFileKind(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('ole');
    expect(sniffFileKind(text('a,b,c\n1,2,3\n'))).toBe('text');
    expect(sniffFileKind(text('{"version":1}'))).toBe('text');
  });

  it('calls HTML, SVG and XML markup, with or without a byte-order mark or leading blanks', () => {
    expect(sniffFileKind(SVG)).toBe('markup');
    expect(sniffFileKind(HTML)).toBe('markup');
    expect(sniffFileKind(text('﻿  \n<?xml version="1.0"?><svg/>'))).toBe('markup');
  });

  it('does not take binary data without a known signature for text', () => {
    expect(sniffFileKind(bytes(1, 2, 3, 4, 0, 5, 6))).toBe('unknown');
    expect(sniffFileKind(bytes(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00))).toBe('unknown');
  });
});

describe('checkUpload', () => {
  /** A file of `size` bytes that starts with `head`. */
  const check = (purpose: UploadPurposeId, head: Uint8Array, size: number, extra: { claimedMime?: string; name?: string } = {}) =>
    checkUpload(purpose, { size, head, ...extra });

  it('accepts a file below, and exactly at, its cap, and refuses one byte over', () => {
    expect(check('eventFile', PDF, 10 * MB - 1).ok).toBe(true);
    expect(check('eventFile', PDF, 10 * MB).ok).toBe(true);
    const over = check('eventFile', PDF, 10 * MB + 1);
    expect(over).toMatchObject({ ok: false, status: 413, error: 'too_large' });
    expect(over.ok ? '' : over.message).toMatch(/10 MB/);
  });

  it('holds pictures to a lower cap than PDFs', () => {
    expect(check('eventFile', PNG, 5 * MB).ok).toBe(true);
    expect(check('eventFile', PNG, 5 * MB + 1)).toMatchObject({ ok: false, status: 413 });
    expect(check('eventFile', JPEG, 5 * MB + 1)).toMatchObject({ ok: false, status: 413 });
    expect(check('eventFile', PDF, 5 * MB + 1).ok).toBe(true);
  });

  it('checks the logo cap at, below and above', () => {
    expect(check('logo', PNG, 256 * 1024 - 1).ok).toBe(true);
    expect(check('logo', PNG, 256 * 1024).ok).toBe(true);
    expect(check('logo', PNG, 256 * 1024 + 1)).toMatchObject({ ok: false, status: 413 });
  });

  it('refuses an empty file with a 400', () => {
    expect(check('invoice', PDF, 0)).toMatchObject({ ok: false, status: 400, error: 'empty' });
  });

  it('refuses a file whose bytes are not what its name and type say', () => {
    // A JPEG called invoice.pdf and claiming to be a PDF.
    const res = check('invoice', JPEG, 1000, { claimedMime: 'application/pdf', name: 'invoice.pdf' });
    expect(res).toMatchObject({ ok: false, status: 415, error: 'unsupported_type' });
    // Right bytes, contradicting claim.
    const lie = check('eventFile', PDF, 1000, { claimedMime: 'image/png', name: 'x.png' });
    expect(lie).toMatchObject({ ok: false, status: 415, error: 'type_mismatch' });
    expect(lie.ok ? '' : lie.message).toMatch(/image\/png.*PDF/);
    // Plain text with a PDF extension and type.
    expect(check('invoice', text('hello, not a pdf'), 16, { claimedMime: 'application/pdf', name: 'a.pdf' })).toMatchObject({ ok: false, status: 415 });
  });

  it('refuses HTML and SVG, including when disguised as an image', () => {
    for (const body of [SVG, HTML]) {
      for (const purpose of ['eventFile', 'logo', 'referenceImage', 'designFile', 'pickedImage'] as const) {
        const res = check(purpose, body, body.length, { claimedMime: 'image/png', name: 'cat.png' });
        expect(res, purpose).toMatchObject({ ok: false, status: 415, error: 'unsupported_type' });
        expect(res.ok ? '' : res.message).toMatch(/HTML, SVG/);
      }
    }
    // The name alone is enough, even over real picture bytes.
    expect(check('eventFile', PNG, 100, { name: 'logo.svg' })).toMatchObject({ ok: false, status: 415 });
    expect(check('eventFile', PNG, 100, { name: 'page.HTML' })).toMatchObject({ ok: false, status: 415 });
  });

  it('stores the type the bytes prove, not whatever the client said', () => {
    expect(check('eventFile', JPEG, 100, { claimedMime: 'image/jpg' })).toMatchObject({ ok: true, kind: 'jpeg', mime: 'image/jpg' });
    expect(check('eventFile', JPEG, 100, { claimedMime: 'application/octet-stream' })).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(check('eventFile', JPEG, 100)).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(check('eventFile', text('a,b\n'), 4, { claimedMime: 'text/csv' })).toMatchObject({ ok: true, mime: 'text/csv' });
  });

  it('keeps zip-based event files to the kinds a phone opens', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
    expect(check('eventFile', zip, 100, { claimedMime: 'application/vnd.apple.pkpass' }).ok).toBe(true);
    expect(check('eventFile', zip, 100, { claimedMime: 'application/zip' })).toMatchObject({ ok: false, status: 415 });
    expect(check('spreadsheetImport', zip, 100).ok).toBe(true);
    expect(check('spreadsheetImport', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 100).ok).toBe(true);
    expect(check('designFile', zip, 100, { claimedMime: 'application/zip' }).ok).toBe(true);
  });

  it('says what is allowed when a type is not', () => {
    const res = check('invoice', PNG, 100);
    expect(res.ok ? '' : res.message).toMatch(/Use PDF/);
  });

  it('has a cap for every purpose, none above what the server can take as a body', () => {
    for (const id of Object.keys(UPLOAD_PURPOSES) as UploadPurposeId[]) {
      expect(maxBytesFor(id), id).toBeGreaterThan(0);
      expect(maxBytesFor(id), id).toBeLessThanOrEqual(256 * MB);
    }
  });
});

describe('checkPickedFile', () => {
  const file = (name: string, type: string, body: Uint8Array, size = body.length) => ({
    name,
    type,
    size,
    slice: (a: number, b: number) => ({ arrayBuffer: async () => body.slice(a, b).buffer as ArrayBuffer }),
  });

  it('passes a real PDF and returns null', async () => {
    expect(await checkPickedFile('invoice', file('a.pdf', 'application/pdf', PDF))).toBeNull();
  });

  it('returns the same readable message the server would send', async () => {
    expect(await checkPickedFile('invoice', file('a.pdf', 'application/pdf', JPEG))).toMatch(/not a type that can be uploaded/);
    expect(await checkPickedFile('logo', file('x.png', 'image/png', SVG))).toMatch(/HTML, SVG/);
  });

  it('refuses an oversized file without reading it', async () => {
    let read = false;
    const big = { name: 'a.pdf', type: 'application/pdf', size: 11 * MB, slice: () => ((read = true), { arrayBuffer: async () => new ArrayBuffer(0) }) };
    expect(await checkPickedFile('invoice', big)).toMatch(/limit/);
    expect(read).toBe(false);
  });
});

describe('base64 helpers', () => {
  it('measures a base64 string without decoding it', () => {
    for (const n of [1, 2, 3, 4, 10, 1000]) {
      expect(base64DecodedSize(Buffer.alloc(n).toString('base64'))).toBe(n);
    }
  });

  it('sizes a body limit to fit the largest file and its JSON', () => {
    const max = 1000;
    expect(base64BodyLimit(max)).toBeGreaterThanOrEqual(Buffer.alloc(max).toString('base64').length);
  });
});
