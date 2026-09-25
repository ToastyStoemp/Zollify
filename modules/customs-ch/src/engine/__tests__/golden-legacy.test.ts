/**
 * Golden-file verification: the legacy customs tool (app/public/legacy/app.js)
 * is executed in a sandbox with stubbed DOM globals, and every document it
 * generates is diffed byte-for-byte against the v2 port for the same state.
 * The old app is the oracle - these documents have legal consequences.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { buildEdecXml } from '../edec-xml';
import { buildGoodsListHtml, type GoodsDocNum, type GoodsFormat } from '../goods-list';
import { buildAllVersionsHtml } from '../all-versions';
import { buildProformaHtml } from '../proforma';
import { build1174Html } from '../form1174';
import { build1187Html } from '../form1187';

const appJsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../legacy/app.js');

// ── Legacy sandbox ───────────────────────────────────────────────────────────

interface Captured {
  html: string[];
  blobs: string[];
}

interface LegacyApi {
  loadState(state: CustomsState): void;
  generateEdecXML(): void;
  printGoodsList(docNum: number, format?: string): void;
  printAllVersions(onlyDocNum?: number | null): void;
  printProformaInvoice(): void;
  print1174(): void;
  print1187(): void;
}

function makeFakeElement(): Record<string, unknown> {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c: unknown) {
      return c;
    },
    removeChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    click() {},
    focus() {},
    innerHTML: '',
    textContent: '',
    value: '',
    offsetHeight: 0,
  };
}

function loadLegacy(captured: Captured): LegacyApi {
  // The port writes a plain hyphen where the legacy tool wrote an em or en
  // dash (placeholders, date ranges); that glyph is the only intended difference.
  const source = readFileSync(appJsPath, 'utf8').replace(/\\u201[34]/g, '-').replace(/[\u2013\u2014]/g, '-');

  const fakeDocument = {
    createElement: () => makeFakeElement(),
    createTextNode: (t: string) => ({ text: t }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeFakeElement(),
    documentElement: makeFakeElement(),
  };

  const fakeWindow: Record<string, unknown> = {
    open: () => ({
      document: {
        write: (h: string) => captured.html.push(h),
        close() {},
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  fakeWindow.parent = fakeWindow;

  class FakeBlob {
    constructor(parts: unknown[]) {
      captured.blobs.push(parts.map(String).join(''));
    }
  }
  const fakeURL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

  let stored: string | null = null;
  const fakeLocalStorage = {
    getItem: (k: string) => (k === 'zolltool_state_v1' ? stored : null),
    setItem: (k: string, v: string) => {
      if (k === 'zolltool_state_v1') stored = v;
    },
    removeItem() {},
  };

  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'URL',
    'Blob',
    'navigator',
    'setTimeout',
    'clearTimeout',
    'fetch',
    `${source}
    return { generateEdecXML, printGoodsList, printAllVersions, printProformaInvoice, print1174, print1187, loadFromStorage };`,
  );
  const api = factory(
    fakeWindow,
    fakeDocument,
    fakeLocalStorage,
    fakeURL,
    FakeBlob,
    {},
    () => 0,
    () => {},
    () => Promise.reject(new Error('no fetch in sandbox')),
  ) as LegacyApi & { loadFromStorage(): void };

  return {
    ...api,
    loadState(state: CustomsState) {
      stored = JSON.stringify(state);
      api.loadFromStorage();
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function richState(): CustomsState {
  return {
    meta: {
      ...defaultCustomsMeta(),
      event: 'Fantasy Basel 2026',
      eventDateStart: '2026-05-14',
      eventDateEnd: '2026-05-16',
      eventLocation: 'Basel',
      companyCode: 'PN',
      documentNumber: 2,
      venueName: 'Messe Basel',
      venueStreet: 'Messeplatz 10',
      venuePostcode: '4058',
      venueCity: 'Basel',
      venueCountry: 'Switzerland',
      currency: 'CHF',
    },
    artist: {
      ...defaultCustomsArtist(),
      companyName: 'Müller & Söhne <Atelier>',
      fullName: 'Wolf "The Artist" Van H.',
      street: 'Kerkstraat 12',
      postCodeCity: '9000 Gent',
      countryOfOrigin: 'Belgium',
      phone: '+32 123 45 67 89',
      email: 'wolf@example.com',
    },
    edec: {
      ...defaultCustomsEdec(),
      transportMode: '3',
      transportationType: '1',
      transportationCountry: 'be',
      transportationNumber: '1-ABC-123',
    },
    form1174: defaultCustomsForm1174(),
    products: [
      {
        id: 'p1',
        title: 'Art Print A3 <Special> & "Rare"',
        sku: 'PR-001',
        type: 'Print',
        forSale: true,
        unlisted: false,
        price: 25,
        weightG: 120,
        tariffNo: '4911.91.00',
        tariffRate: 8.1,
        vatRate: 8.1,
        packagingType: 'CT',
        originCountry: 'BE',
        amount: 40,
        soldQty: 12,
        soldValue: 287.5,
        variants: [],
      },
      {
        id: 'p2',
        title: 'Artbook Vol. 1',
        type: 'Book',
        forSale: true,
        unlisted: false,
        price: null,
        priceNote: 'mixed',
        weightG: 450,
        totalValueCHF: 440,
        tariffNo: '4901.99.00',
        tariffRate: 2.6,
        vatRate: 2.6,
        packagingType: 'CT',
        amount: 20,
        soldQty: 3,
        soldValue: 0,
        variants: [],
      },
      {
        id: 'p3',
        title: 'Enamel Pin',
        sku: 'PIN',
        type: 'Pin',
        forSale: true,
        unlisted: false,
        price: 12,
        weightG: 25,
        tariffNo: '7117.19.00',
        tariffRate: 8.1,
        vatRate: 8.1,
        packagingType: 'NE',
        permitOverride: 0,
        amount: 0,
        soldQty: 0,
        soldValue: 0,
        variants: [
          { name: 'Dragon', sku: 'PIN-DRG', amount: 30, soldQty: 10, soldValue: 120 },
          { name: 'Wolf', price: 14, weightG: 30, amount: 20, soldQty: 5, soldValue: 70 },
          { name: 'Prototype', amount: 5, soldQty: 2, soldValue: 24, unlisted: true },
        ],
      },
      {
        id: 'p4',
        title: 'Display Stand',
        type: 'Equipment',
        forSale: false,
        unlisted: true,
        price: 80,
        weightG: 2000,
        tariffNo: '3926.90.00',
        tariffRate: 8.1,
        vatRate: 8.1,
        amount: 2,
        soldQty: 0,
        soldValue: 0,
        variants: [],
      },
      {
        id: 'p5',
        title: 'Mystery Item',
        type: 'Other',
        forSale: true,
        unlisted: false,
        price: 5,
        weightG: 50,
        amount: 10,
        soldQty: 10,
        soldValue: 50,
        variants: [],
      },
    ],
  };
}

function manualGroupState(): CustomsState {
  const s = richState();
  s.form1174 = { groupMode: 'manual', assignments: [1, 2, 1, 0, 2] };
  return s;
}

function nothingSoldState(): CustomsState {
  const s = richState();
  s.products = s.products.map((p) => ({
    ...p,
    soldQty: 0,
    soldValue: 0,
    variants: (p.variants ?? []).map((v) => ({ ...v, soldQty: 0, soldValue: 0 })),
  }));
  return s;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * The Material column (goods-list.ts, all-versions.ts, proforma.ts) is a
 * deliberate, permanent divergence from legacy - the old tool has no concept
 * of material at all, so there is no fixture to reconcile against. Every
 * `<th>`/`<td>` for it carries `class="mat"` for exactly this: strip it from
 * the PORTED html before diffing, so every other cell still has to match
 * legacy byte-for-byte and a real regression there still fails loudly.
 */
const stripMaterialColumn = (html: string): string => html.replace(/\n?[ \t]*<(th|td) class="mat">.*?<\/\1>/g, '');

/**
 * A by-type group of exactly one product now names itself after that
 * product's title instead of its type (also a deliberate, permanent
 * divergence - legacy always shows the type). The cell carries its type in a
 * data-type attribute for exactly this: swap it back before diffing, so a
 * real regression to the type-only case (or anywhere else on the page) still
 * fails loudly.
 */
const normalizeByTypeGroupName = (html: string): string => html.replace(/<strong data-type="([^"]*)">.*?<\/strong>/g, '<strong>$1</strong>');

/**
 * compute1174Groups (calc.ts) now excludes products that fail hasCustomsInfo
 * or have a zero computed amount from Group 1/2's sums - the same filter the
 * goods list and both proformas already apply, so 11.74/11.87's totals stay
 * consistent with the import list/proforma instead of a hidden/zero-stock
 * product quietly inflating just these two forms' weight and value. Legacy
 * never had this filter here, so richState()'s "Display Stand" (unlisted, so
 * hasCustomsInfo is false) legitimately produces different group numbers,
 * and on 11.87 a different return-goods description list, from legacy - a
 * deliberate, permanent divergence, same idea as stripMaterialColumn above.
 * `.gfv` is used nowhere else in either form, so this only ever touches the
 * cells the fix can actually change - a real regression anywhere else on the
 * page still fails loudly.
 */
const normalizeGroupNumbers = (html: string): string => html.replace(/<span class="gfv">.*?<\/span>/g, '<span class="gfv"></span>');

// ── Tests ───────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-07-07T09:15:30Z');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('customs port vs legacy (golden diff)', () => {
  const fixtures: [string, () => CustomsState][] = [
    ['auto grouping', richState],
    ['manual grouping', manualGroupState],
  ];

  it('produces identical e-dec XML', () => {
    for (const [, make] of fixtures) {
      const captured: Captured = { html: [], blobs: [] };
      const legacy = loadLegacy(captured);
      legacy.loadState(clone(make()));
      legacy.generateEdecXML();
      const ported = buildEdecXml(clone(make()), new Date());
      expect(ported).not.toBeNull();
      expect(captured.blobs).toHaveLength(1);
      expect(ported!.xml).toBe(captured.blobs[0]);
    }
  });

  it('returns null / no export when nothing is sold', () => {
    const captured: Captured = { html: [], blobs: [] };
    const legacy = loadLegacy(captured);
    legacy.loadState(clone(nothingSoldState()));
    legacy.generateEdecXML();
    expect(captured.blobs).toHaveLength(0);
    expect(buildEdecXml(clone(nothingSoldState()), new Date())).toBeNull();
  });

  it('produces identical goods lists (2 documents × 3 formats)', () => {
    // docNum 1 (Import) was replaced by packing-list.ts - no longer a legacy
    // port, so no legacy oracle to diff against here. See packing-list.test.ts.
    for (const [, make] of fixtures) {
      for (const docNum of [2, 3] as GoodsDocNum[]) {
        for (const format of ['detailed', 'compressed', 'bytype'] as GoodsFormat[]) {
          const captured: Captured = { html: [], blobs: [] };
          const legacy = loadLegacy(captured);
          legacy.loadState(clone(make()));
          legacy.printGoodsList(docNum, format);
          const ported = buildGoodsListHtml(clone(make()), docNum, format);
          expect(captured.html, `doc ${docNum} / ${format}`).toHaveLength(1);
          expect(normalizeByTypeGroupName(stripMaterialColumn(ported)), `doc ${docNum} / ${format}`).toBe(captured.html[0]);
        }
      }
    }
  });

  it('produces an identical all-formats bundle', () => {
    for (const only of [null, 2] as (GoodsDocNum | null)[]) {
      const captured: Captured = { html: [], blobs: [] };
      const legacy = loadLegacy(captured);
      legacy.loadState(clone(richState()));
      legacy.printAllVersions(only);
      const ported = buildAllVersionsHtml(clone(richState()), only);
      expect(captured.html).toHaveLength(1);
      expect(normalizeByTypeGroupName(stripMaterialColumn(ported))).toBe(captured.html[0]);
    }
  });

  it('produces an identical proforma invoice', () => {
    const captured: Captured = { html: [], blobs: [] };
    const legacy = loadLegacy(captured);
    legacy.loadState(clone(richState()));
    legacy.printProformaInvoice();
    const ported = buildProformaHtml(clone(richState()), new Date());
    expect(captured.html).toHaveLength(1);
    expect(stripMaterialColumn(ported)).toBe(captured.html[0]);
  });

  it('produces an identical form 11.74', () => {
    for (const [, make] of fixtures) {
      const captured: Captured = { html: [], blobs: [] };
      const legacy = loadLegacy(captured);
      legacy.loadState(clone(make()));
      legacy.print1174();
      const ported = build1174Html(clone(make()), new Date());
      expect(captured.html).toHaveLength(1);
      expect(normalizeGroupNumbers(ported)).toBe(normalizeGroupNumbers(captured.html[0]!));
    }
  });

  it('produces an identical form 11.87', () => {
    for (const [, make] of fixtures) {
      const captured: Captured = { html: [], blobs: [] };
      const legacy = loadLegacy(captured);
      legacy.loadState(clone(make()));
      legacy.print1187();
      const ported = build1187Html(clone(make()), new Date());
      expect(captured.html).toHaveLength(1);
      expect(normalizeGroupNumbers(ported)).toBe(normalizeGroupNumbers(captured.html[0]!));
    }
  });
});
