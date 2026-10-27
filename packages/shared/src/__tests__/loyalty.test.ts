import { describe, expect, it } from 'vitest';
import type { Transaction } from '../types';
import { DEFAULT_LOYALTY_SETTINGS, LoyaltySettingsSchema, earnedFor, isMemberCode, memberCodeIn, rewardAmount, rewardLabel, saleLoyalty, standingOf, type LoyaltySettings } from '../loyalty';

/** Stamps and points: what a sale earns, what a reward is worth, and what the sale's lines say. */

const stamps: LoyaltySettings = { ...DEFAULT_LOYALTY_SETTINGS, scheme: 'stamps', stampEvery: 10, rewardCost: 10, reward: { kind: 'amount', amount: 5 } };
const points: LoyaltySettings = { ...DEFAULT_LOYALTY_SETTINGS, scheme: 'points', pointsPerUnit: 2, rewardCost: 100, reward: { kind: 'percent', percent: 10 } };
const money = (n: number) => `€${n.toFixed(2)}`;

describe('earning', () => {
  it('gives whole stamps per spend, and nothing under the minimum', () => {
    expect(earnedFor(stamps, 9.99)).toBe(0);
    expect(earnedFor(stamps, 10)).toBe(1);
    expect(earnedFor(stamps, 29.99)).toBe(2);
    expect(earnedFor(stamps, 30)).toBe(3);
    expect(earnedFor({ ...stamps, minSpend: 15 }, 12)).toBe(0);
    expect(earnedFor({ ...stamps, minSpend: 15 }, 20)).toBe(2);
    expect(earnedFor(stamps, 0)).toBe(0);
    expect(earnedFor(stamps, -5)).toBe(0);
  });

  it('gives points per unit paid', () => {
    expect(earnedFor(points, 12.5)).toBe(25);
    expect(earnedFor(points, 0.49)).toBe(0);
    expect(earnedFor({ ...points, pointsPerUnit: 0.1 }, 100)).toBe(10);
  });
});

describe('standing', () => {
  it('counts rewards the balance covers and what is still to go', () => {
    expect(standingOf(stamps, 23, 10)).toEqual({ earned: 23, spent: 10, balance: 13, rewards: 1, toNext: 7 });
    expect(standingOf(stamps, 10, 0)).toEqual({ earned: 10, spent: 0, balance: 10, rewards: 1, toNext: 10 });
    expect(standingOf(stamps, 3, 10).balance).toBe(0);
  });
});

describe('the reward', () => {
  it('is a fixed amount, never more than the sale', () => {
    expect(rewardAmount(stamps, 40)).toBe(5);
    expect(rewardAmount(stamps, 3.5)).toBe(3.5);
    expect(rewardAmount(stamps, 0)).toBe(0);
  });
  it('is a share of the sale', () => {
    expect(rewardAmount(points, 33.33)).toBe(3.33);
  });
  it('is a chosen item up to the cap', () => {
    const item: LoyaltySettings = { ...stamps, reward: { kind: 'item', upTo: 8 } };
    expect(rewardAmount(item, 50, 6.5)).toBe(6.5);
    expect(rewardAmount(item, 50, 12)).toBe(8);
    expect(rewardAmount(item, 5, 12)).toBe(5);
    expect(rewardAmount(item, 50)).toBe(0);
  });
  it('says what it is', () => {
    expect(rewardLabel(stamps, money)).toBe('10 stamps = €5.00 off');
    expect(rewardLabel(points, money)).toBe('100 points = 10% off a sale');
    expect(rewardLabel({ ...stamps, rewardCost: 1, reward: { kind: 'item', upTo: 8 } }, money)).toBe('1 stamp = a free item up to €8.00');
  });
});

describe('member codes', () => {
  it('are LY- and 16 base32 characters, found in a scanned value or a card URL', () => {
    expect(isMemberCode('LY-0123456789ABCDEF')).toBe(true);
    expect(isMemberCode('ly-0123456789abcdef')).toBe(true);
    expect(isMemberCode('LY-0123456789ABCDE')).toBe(false);
    expect(isMemberCode('LY-0123456789ABCDEI')).toBe(false);
    expect(memberCodeIn('https://shop.example/p/loyalty/c/LY-0123456789ABCDEF')).toBe('LY-0123456789ABCDEF');
    expect(memberCodeIn('  ly-0123456789abcdef ')).toBe('LY-0123456789ABCDEF');
    expect(memberCodeIn('SMP-POSTCARDS')).toBeNull();
  });
});

describe("a sale's lines", () => {
  const line = (over: Partial<Transaction['items'][number]>) => ({ pid: 'x', vid: null, title: 'x', qty: 1, unitPrice: 0, lineTotal: 0, ...over });
  const tx = (items: Transaction['items'], total: number, baseTotal?: number) => ({ items, total, ...(baseTotal != null ? { baseTotal } : {}) });

  it("earns for the member named, on what was paid, and takes a reward's cost", () => {
    const member = line({ title: 'Stamp card', ref: { moduleId: 'loyalty', kind: 'member', id: 'm1' } });
    expect(saleLoyalty(stamps, tx([line({ pid: 'pin', unitPrice: 25, lineTotal: 25 }), member], 25))).toEqual({ memberId: 'm1', earned: 2, spent: 0, rewardAmount: 0 });
    const reward = line({ title: 'Reward', unitPrice: -5, lineTotal: -5, ref: { moduleId: 'loyalty', kind: 'reward', id: 'm1' } });
    expect(saleLoyalty(stamps, tx([line({ pid: 'pin', unitPrice: 25, lineTotal: 25 }), member, reward], 20))).toEqual({ memberId: 'm1', earned: 2, spent: 10, rewardAmount: 5 });
  });

  it('reads the book currency figure for a converted sale', () => {
    const member = line({ ref: { moduleId: 'loyalty', kind: 'member', id: 'm1' } });
    expect(saleLoyalty(stamps, tx([line({ pid: 'pin', unitPrice: 300, lineTotal: 300 }), member], 300, 27))?.earned).toBe(2);
  });

  it('is nothing without a member line, even with a reward line', () => {
    expect(saleLoyalty(stamps, tx([line({ pid: 'pin', unitPrice: 25, lineTotal: 25 })], 25))).toBeNull();
    expect(saleLoyalty(stamps, tx([line({ unitPrice: -5, lineTotal: -5, ref: { moduleId: 'loyalty', kind: 'reward', id: 'm1' } })], 20))).toBeNull();
  });
});

describe('settings', () => {
  it('fill in defaults and refuse nonsense', () => {
    expect(LoyaltySettingsSchema.parse({}).scheme).toBe('stamps');
    expect(LoyaltySettingsSchema.parse({}).staffMaySet).toBe(false);
    expect(LoyaltySettingsSchema.parse({}).passBarcode).toBe('qr');
    expect(LoyaltySettingsSchema.safeParse({ passBarcode: 'ean13' }).success).toBe(false);
    expect(LoyaltySettingsSchema.parse({ reward: { kind: 'percent', percent: 15 } }).reward).toEqual({ kind: 'percent', percent: 15 });
    expect(LoyaltySettingsSchema.safeParse({ reward: { kind: 'percent', percent: 150 } }).success).toBe(false);
    expect(LoyaltySettingsSchema.safeParse({ rewardCost: 0 }).success).toBe(false);
  });
});
