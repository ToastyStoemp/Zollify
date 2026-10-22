import { describe, expect, it } from 'vitest';
import { choiceOf, customerFields, duplicatesIn, emptyChoice, erasureNote, quickCustomer, retentionLine, walkInName } from '../customer-form';

const mira = { id: 'c1', name: 'Mira', email: 'mira@example.test', phone: '' };

describe('customerFields', () => {
  it('sends the id of a picked customer and nothing else about them', () => {
    expect(customerFields(choiceOf(mira))).toEqual({ customerId: 'c1', forceNewCustomer: false });
  });

  it('sends a typed-in customer as one nested object, forced only when the seller said so', () => {
    const typed = { ...emptyChoice(), name: 'Ana', email: 'ana@example.test' };
    expect(customerFields(typed)).toEqual({ customer: { name: 'Ana', email: 'ana@example.test', phone: '' }, forceNewCustomer: false });
    expect(customerFields(typed, true).forceNewCustomer).toBe(true);
  });
});

describe('retentionLine', () => {
  it('names the configured number of days', () => {
    expect(retentionLine(30)).toBe('Details are erased 30 days after their last commission closes.');
    expect(retentionLine(1)).toBe('Details are erased 1 day after their last commission closes.');
    expect(retentionLine(0)).toBe('Details are erased as soon as their last commission closes.');
  });
});

describe('erasureNote', () => {
  it('says in use while a commission is open, else the date', () => {
    expect(erasureNote(null, 1)).toMatch(/still open/);
    expect(erasureNote(123, 2)).toMatch(/still open/);
    expect(erasureNote(Date.UTC(2030, 0, 15, 12), 0)).toMatch(/^Details are erased on .*2030\.$/);
  });
});

describe('duplicatesIn', () => {
  it('reads the server\'s offer, and ignores other errors', () => {
    expect(duplicatesIn({ body: { error: 'customer_exists', matches: [mira] } })).toEqual([mira]);
    expect(duplicatesIn({ body: { error: 'invalid_request' } })).toBeNull();
    expect(duplicatesIn(new Error('x'))).toBeNull();
    expect(duplicatesIn(null)).toBeNull();
  });
});

describe('the quick form at the till', () => {
  const at = new Date('2026-10-22T15:00:00');
  it('files a nameless commission under a walk-in name with the day', () => {
    expect(walkInName(at)).toBe('Walk-in, 22 Oct');
    expect(quickCustomer('  ', '', false, at)).toEqual({ customer: { name: 'Walk-in, 22 Oct', email: '', phone: '' }, forceNewCustomer: false });
  });
  it('keeps what was typed, trimmed, and passes "add anyway" on', () => {
    expect(quickCustomer(' Mira ', ' mira@example.test ', true, at)).toEqual({ customer: { name: 'Mira', email: 'mira@example.test', phone: '' }, forceNewCustomer: true });
  });
});
