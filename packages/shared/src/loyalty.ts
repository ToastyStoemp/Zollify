import { z } from 'zod';
import type { Transaction } from './types';

/**
 * Loyalty - a stamp card or points on a customer's phone. The rules of
 * earning and redeeming, shared by the till (which marks a sale as a
 * member's and puts a reward in the cart), the server (which counts what
 * each member has from the synced sales, as commissions count what was
 * paid) and the customer's own card page.
 *
 * A sale earns for a member when it carries a zero-price line whose `ref`
 * names the member; a reward is a negative line whose `ref` names the
 * member too. Both ride in the ordinary sale, so a reverted sale gives the
 * stamps back and takes the reward back by itself.
 */

export const LOYALTY_MODULE_ID = 'loyalty';
/** The zero-price line that says whose sale this is. */
export const LOYALTY_MEMBER_REF_KIND = 'member';
/** The negative line of a reward redeemed. */
export const LOYALTY_REWARD_REF_KIND = 'reward';
export const LOYALTY_MEMBER_LINE_KEY = 'loyalty:member';
export const LOYALTY_REWARD_LINE_KEY = 'loyalty:reward';
/** The customer's card: `/p/loyalty/c/<code>`; joining: `/p/loyalty/j/<join token>`. */
export const LOYALTY_PUBLIC_PATH = '/p/loyalty/';

export type LoyaltyScheme = 'stamps' | 'points';

export const LoyaltyRewardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), amount: z.number().positive().max(100_000) }),
  z.object({ kind: z.literal('percent'), percent: z.number().min(1).max(100) }),
  z.object({ kind: z.literal('item'), upTo: z.number().positive().max(100_000) }),
]);
export type LoyaltyReward = z.infer<typeof LoyaltyRewardSchema>;

export const LoyaltySettingsSchema = z.object({
  /** What the card is called on the pass and the join page. */
  programme: z.string().trim().max(60).default(''),
  scheme: z.enum(['stamps', 'points']).default('stamps'),
  /** Stamps: one for every this much paid in a sale (whole stamps only). */
  stampEvery: z.number().positive().max(100_000).default(10),
  /** Points: this many for each unit of currency paid. */
  pointsPerUnit: z.number().positive().max(1000).default(1),
  /** What a reward costs, in stamps or points. */
  rewardCost: z.number().int().positive().max(100_000).default(10),
  reward: LoyaltyRewardSchema.default({ kind: 'amount', amount: 5 }),
  /** A sale below this earns nothing; 0 for any sale. */
  minSpend: z.number().min(0).max(100_000).default(0),
  /** A line under the title on the join page. */
  joinIntro: z.string().trim().max(400).default(''),
  /** A member with nothing earned for this long is erased; 0 keeps them. */
  eraseAfterMonths: z.number().int().min(0).max(120).default(24),
});
export type LoyaltySettings = z.infer<typeof LoyaltySettingsSchema>;
export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = LoyaltySettingsSchema.parse({});

/** "stamps" or "points", as the card says it. */
export const loyaltyUnit = (s: Pick<LoyaltySettings, 'scheme'>, n = 2): string => (s.scheme === 'stamps' ? (n === 1 ? 'stamp' : 'stamps') : n === 1 ? 'point' : 'points');

/** What a sale that came to `paid` earns: whole stamps per `stampEvery`, or points per unit; nothing under `minSpend`. */
export function earnedFor(s: LoyaltySettings, paid: number): number {
  const amount = Number(paid) || 0;
  if (amount <= 0 || amount < s.minSpend) return 0;
  return s.scheme === 'stamps' ? Math.floor(amount / s.stampEvery + 1e-9) : Math.floor(amount * s.pointsPerUnit + 1e-9);
}

export interface LoyaltyStanding {
  earned: number;
  spent: number;
  balance: number;
  /** Rewards the balance covers right now. */
  rewards: number;
  /** Stamps or points still to go to the next reward. */
  toNext: number;
}

export function standingOf(s: Pick<LoyaltySettings, 'rewardCost'>, earned: number, spent: number): LoyaltyStanding {
  const balance = Math.max(0, earned - spent);
  const rewards = Math.floor(balance / s.rewardCost);
  return { earned, spent, balance, rewards, toNext: s.rewardCost - (balance % s.rewardCost) };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * What a reward takes off a sale: a fixed amount (never more than the sale),
 * a share of it, or a chosen item's price up to the cap. Zero when the cart
 * is empty - nothing to take it off.
 */
export function rewardAmount(s: Pick<LoyaltySettings, 'reward'>, cartTotal: number, itemPrice = 0): number {
  const total = Math.max(0, Number(cartTotal) || 0);
  const r = s.reward;
  if (r.kind === 'amount') return round2(Math.min(r.amount, total));
  if (r.kind === 'percent') return round2((total * r.percent) / 100);
  return round2(Math.min(Math.max(0, Number(itemPrice) || 0), r.upTo, total));
}

/** The reward in words, for the pass and the join page. */
export function rewardLabel(s: Pick<LoyaltySettings, 'reward' | 'rewardCost' | 'scheme'>, money: (n: number) => string): string {
  const r = s.reward;
  const what = r.kind === 'amount' ? `${money(r.amount)} off` : r.kind === 'percent' ? `${r.percent}% off a sale` : `a free item up to ${money(r.upTo)}`;
  return `${s.rewardCost} ${loyaltyUnit(s, s.rewardCost)} = ${what}`;
}

/** A member's code: `LY-` and 16 characters of Crockford base32 (80 random bits), as printed in the pass's QR. */
export const MEMBER_CODE_RE = /^LY-[0-9A-HJKMNP-TV-Z]{16}$/;
export const isMemberCode = (text: string): boolean => MEMBER_CODE_RE.test(text.trim().toUpperCase());

/** The member code in a scanned value: the code itself, or the card's URL ending in it. */
export function memberCodeIn(text: string): string | null {
  const m = /LY-[0-9A-HJKMNP-TV-Z]{16}/i.exec(String(text ?? '').toUpperCase().replace(/[^\x20-\x7E]/g, ''));
  return m ? m[0] : null;
}

/** What a sale did for a member: which member, what it earned, and whether a reward was taken. */
export interface SaleLoyalty {
  memberId: string;
  earned: number;
  /** Stamps or points a redeemed reward cost; 0 when none was taken. */
  spent: number;
  /** The reward's value as charged, when one was taken. */
  rewardAmount: number;
}

/**
 * Reads a sale's loyalty lines. Earning is on what was paid in the event's
 * book currency - the sale's total, the reward already off it - so a card
 * holder is not stamped for money a reward covered. A sale with a reward
 * line but no member line is not a member's sale: nothing is read.
 */
export function saleLoyalty(s: LoyaltySettings, tx: Pick<Transaction, 'items' | 'total' | 'baseTotal'>): SaleLoyalty | null {
  const member = tx.items.find((i) => i.ref?.moduleId === LOYALTY_MODULE_ID && i.ref.kind === LOYALTY_MEMBER_REF_KIND);
  if (!member?.ref) return null;
  const reward = tx.items.find((i) => i.ref?.moduleId === LOYALTY_MODULE_ID && i.ref.kind === LOYALTY_REWARD_REF_KIND && i.ref.id === member.ref!.id);
  const paid = tx.baseTotal ?? tx.total;
  return {
    memberId: member.ref.id,
    earned: earnedFor(s, paid),
    spent: reward ? s.rewardCost : 0,
    rewardAmount: reward ? round2(-(reward.baseLineTotal ?? reward.lineTotal)) : 0,
  };
}
