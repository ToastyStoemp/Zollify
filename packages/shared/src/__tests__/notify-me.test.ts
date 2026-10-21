import { describe, expect, it } from 'vitest';
import { NotifySettingsSchema, SubscribeInputSchema, eraseReason, eventRecipients, maskEmail, newsRecipients, restockRecipients, type Subscriber } from '../notify-me';

const sub = (extra: Partial<Subscriber> = {}): Subscriber => ({ id: 's', email: 'mira@example.test', kinds: ['restock'], productIds: [], country: '', source: 'page', createdAt: 1000, confirmedAt: 2000, unsubscribedAt: null, lastSentAt: null, ...extra });
const DAY = 86_400_000;

describe('schemas', () => {
  it('take a lower-case slug and sensible defaults', () => {
    expect(NotifySettingsSchema.parse({})).toMatchObject({ slug: '', kinds: ['restock', 'events', 'news'], restockCooldownDays: 30, eraseAfterMonths: 24 });
    expect(NotifySettingsSchema.safeParse({ slug: 'Ink-Shop' }).success).toBe(false);
    expect(NotifySettingsSchema.safeParse({ slug: 'ink-shop' }).success).toBe(true);
    expect(NotifySettingsSchema.safeParse({ slug: 'ab' }).success).toBe(false);
    expect(NotifySettingsSchema.safeParse({ storeUrl: 'not a url' }).success).toBe(false);
  });

  it('need an email and at least one kind', () => {
    expect(SubscribeInputSchema.parse({ email: ' Mira@Example.test ', kinds: ['news'] })).toMatchObject({ email: 'mira@example.test', productId: '', country: '', website: '' });
    expect(SubscribeInputSchema.safeParse({ email: 'nope', kinds: ['news'] }).success).toBe(false);
    expect(SubscribeInputSchema.safeParse({ email: 'a@b.co', kinds: [] }).success).toBe(false);
    expect(SubscribeInputSchema.safeParse({ email: 'a@b.co', kinds: ['spam'] }).success).toBe(false);
    expect(SubscribeInputSchema.parse({ email: 'a@b.co', kinds: ['events'], country: 'de' }).country).toBe('DE');
  });
});

describe('maskEmail', () => {
  it('keeps the ends and the domain', () => {
    expect(maskEmail('mira@example.test')).toBe('m···a@example.test');
    expect(maskEmail('ab@x.y')).toBe('ab@x.y');
    expect(maskEmail('a@x.y')).toBe('a@x.y');
    expect(maskEmail('nonsense')).toBe('nonsense');
  });
});

describe('who hears what', () => {
  it('a restock goes to those who asked for the item or for anything, confirmed, not told lately', () => {
    const subs = [
      sub({ id: 'any' }),
      sub({ id: 'this', productIds: ['pin'] }),
      sub({ id: 'other', productIds: ['print'] }),
      sub({ id: 'unconfirmed', confirmedAt: null }),
      sub({ id: 'left', unsubscribedAt: 5000 }),
      sub({ id: 'news-only', kinds: ['news'] }),
      sub({ id: 'told', productIds: ['pin'] }),
    ];
    const told = (id: string): number | null => (id === 'told' ? 10 * DAY : null);
    expect(restockRecipients(subs, 'pin', told, 30, 20 * DAY).map((s) => s.id)).toEqual(['any', 'this']);
    // After the cooldown they hear again.
    expect(restockRecipients(subs, 'pin', told, 5, 20 * DAY).map((s) => s.id)).toEqual(['any', 'this', 'told']);
  });

  it('an event goes to those for its country or for anywhere', () => {
    const subs = [sub({ id: 'de', kinds: ['events'], country: 'DE' }), sub({ id: 'dk', kinds: ['events'], country: 'DK' }), sub({ id: 'any', kinds: ['events'] }), sub({ id: 'no', kinds: ['restock'] })];
    expect(eventRecipients(subs, 'de').map((s) => s.id)).toEqual(['de', 'any']);
    expect(eventRecipients(subs, '').map((s) => s.id)).toEqual(['de', 'dk', 'any']);
    expect(newsRecipients([...subs, sub({ id: 'n', kinds: ['news', 'events'] })]).map((s) => s.id)).toEqual(['n']);
  });
});

describe('eraseReason', () => {
  it('erases the unconfirmed after a week, the gone after a month, the silent after the set months', () => {
    expect(eraseReason(sub({ confirmedAt: null, createdAt: 0 }), 24, 6 * DAY)).toBeNull();
    expect(eraseReason(sub({ confirmedAt: null, createdAt: 0 }), 24, 8 * DAY)).toBe('unconfirmed');
    expect(eraseReason(sub({ unsubscribedAt: 0 }), 24, 29 * DAY)).toBeNull();
    expect(eraseReason(sub({ unsubscribedAt: 0 }), 24, 31 * DAY)).toBe('left');
    expect(eraseReason(sub({ confirmedAt: 0 }), 2, 61 * DAY)).toBe('silent');
    expect(eraseReason(sub({ confirmedAt: 0, lastSentAt: 50 * DAY }), 2, 61 * DAY)).toBeNull();
    expect(eraseReason(sub({ confirmedAt: 0 }), 0, 1000 * DAY)).toBeNull();
  });
});
