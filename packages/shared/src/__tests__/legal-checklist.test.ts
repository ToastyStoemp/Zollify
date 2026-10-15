import { describe, expect, it } from 'vitest';
import { countriesInPlay, legalChecklist, openLegalSteps, type LegalFacts } from '../legal-checklist';

const base: LegalFacts = {
  homeCountry: 'Belgium',
  businessName: 'Harbour Prints',
  address: 'Kade 1',
  vatId: '',
  exemptCountries: [],
  exNumber: '',
  eventCountries: [],
  storeCountries: [],
  modules: ['pos'],
  confirmed: {},
};

describe('legal checklist', () => {
  it('lists home first, then stores and events, each country once', () => {
    expect(countriesInPlay({ homeCountry: 'Belgium', storeCountries: ['DK'], eventCountries: ['Germany', 'be', 'DK', ''] })).toEqual([
      { code: 'BE', reason: 'home' },
      { code: 'DK', reason: 'stores' },
      { code: 'DE', reason: 'events' },
    ]);
  });

  it('asks a Belgian business for its enterprise number and VAT, and reads them when there', () => {
    const [be] = legalChecklist(base);
    expect(be!.steps.find((s) => s.id === 'BE.enterprise')?.status).toBe('todo');
    expect(be!.steps.find((s) => s.id === 'BE.vat')?.status).toBe('todo');
    const done = legalChecklist({ ...base, vatId: 'BE 0123.456.789' })[0]!;
    expect(done.steps.find((s) => s.id === 'BE.enterprise')?.status).toBe('done');
    expect(done.steps.find((s) => s.id === 'BE.vat')?.status).toBe('done');
    expect(done.summary).toBe('All set');
  });

  it('walks a German event through switch, TSE, registration and documentation', () => {
    const f: LegalFacts = { ...base, vatId: 'BE 0123.456.789', eventCountries: ['Germany'], kassensichv: false, tseMode: 'none' };
    const de = legalChecklist(f).find((l) => l.code === 'DE')!;
    expect(de.reason).toBe('events');
    expect(de.steps.map((s) => [s.id, s.status])).toEqual(
      expect.arrayContaining([
        ['DE.switch', 'todo'],
        ['DE.tse', 'todo'],
        ['DE.receipt', 'info'],
        ['DE.register', 'manual'],
        ['DE.documentation', 'manual'],
      ]),
    );
    expect(de.summary).toBe('4 steps to do');
    const ready = legalChecklist({ ...f, kassensichv: true, tseMode: 'remote', tseCertified: true, closings: 2, confirmed: { 'DE.register': '2026-10-01', 'DE.documentation': '2026-10-02' } }).find((l) => l.code === 'DE')!;
    expect(ready.steps.find((s) => s.id === 'DE.tse')?.status).toBe('done');
    expect(ready.steps.find((s) => s.id === 'DE.register')?.confirmedOn).toBe('2026-10-01');
    expect(ready.summary).toBe('All set');
    // A test TSE is not enough.
    expect(legalChecklist({ ...f, kassensichv: true, tseMode: 'own', tseCertified: false }).find((l) => l.code === 'DE')!.steps.find((s) => s.id === 'DE.tse')).toMatchObject({ status: 'todo', text: expect.stringContaining('not certified') });
  });

  it('tells a Swiss business about German VAT registration, and an EU exempt one about its EX number', () => {
    const ch = legalChecklist({ ...base, homeCountry: 'Switzerland', vatId: 'CHE-123.456.789 MWST', eventCountries: ['DE'], modules: ['pos', 'customs-ch'] });
    expect(ch[0]!.steps.find((s) => s.id === 'CH.uid')?.status).toBe('done');
    expect(ch[0]!.steps.find((s) => s.id === 'CH.customs')?.status).toBe('done');
    expect(ch[1]!.steps.find((s) => s.id === 'DE.foreign-vat')?.status).toBe('manual');
    const ex = legalChecklist({ ...base, exemptCountries: ['BE', 'DE'], eventCountries: ['DE'] }).find((l) => l.code === 'DE')!;
    expect(ex.steps.find((s) => s.id === 'DE.vat')).toMatchObject({ status: 'todo', panel: 'core.vat' });
    expect(ex.steps.find((s) => s.id === 'DE.foreign-vat')).toBeUndefined();
  });

  it('checks a Danish store’s CVR, books, MobilePay and self-billing agreements', () => {
    const f: LegalFacts = {
      ...base,
      homeCountry: 'Denmark',
      vatId: 'DK12345678',
      storeCountries: ['DK'],
      modules: ['pos', 'economic', 'consignment'],
      economic: { server: true, grant: false },
      consignors: [
        { name: 'Ada', selfBillingAgreedOn: '2026-01-01', vatRegistered: false, vatId: '' },
        { name: 'Bo', selfBillingAgreedOn: null, vatRegistered: true, vatId: 'DK87654321' },
      ],
      customMethods: ['TWINT'],
    };
    const dk = legalChecklist(f)[0]!;
    expect(dk.steps.find((s) => s.id === 'DK.cvr')?.status).toBe('done');
    expect(dk.steps.find((s) => s.id === 'DK.books')).toMatchObject({ status: 'todo', panel: 'economic.economic' });
    expect(dk.steps.find((s) => s.id === 'DK.mobilepay')?.status).toBe('todo');
    expect(dk.steps.find((s) => s.id === 'DK.self-billing')).toMatchObject({ status: 'todo', text: expect.stringContaining('Bo') });
    expect(openLegalSteps([dk])).toBe(4); // books, mobilepay, self-billing, dpa
  });

  it('blocks countries Zollify cannot serve as the till, without the usual profile steps', () => {
    const lists = legalChecklist({ ...base, eventCountries: ['Austria', 'France', 'Sweden'] });
    for (const c of ['AT', 'FR', 'SE']) {
      const l = lists.find((x) => x.code === c)!;
      expect(l.steps).toHaveLength(1);
      expect(l.steps[0]!.status).toBe('blocked');
      expect(l.summary).toContain('cannot');
    }
  });
});
